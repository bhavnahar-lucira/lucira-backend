/**
 * Smart Collection Sort — drafts, versions, scheduled publish & revert.
 *
 * The v2 layer over `smart_sort_rules`:
 *
 *   rule.draft          - a STAGED copy of the ordering fields, edited in the
 *                         admin without touching what is live. Carries its own
 *                         optional `goLiveAt` / `revertAt` (Dates) and `label`.
 *   smart_sort_versions - append-only history: one doc per configuration that
 *                         actually WENT LIVE ({ ruleId, label, source, config,
 *                         publishedAt }). Restoring copies a version back into
 *                         the draft for review — never straight to live.
 *   rule.liveVersionId  - the version doc describing what is live right now;
 *                         stamped into the daily stats so performance can be
 *                         read per version (the time-split A/B view).
 *   rule.scheduledRevert- { at, versionId } — set when a draft is published
 *                         with a revert date: the version holds the order as
 *                         it was JUST BEFORE the publish, and the scheduler
 *                         restores it at `at`. Festive merchandising in one
 *                         move: goes live at midnight, reverts after the sale.
 *
 * The scheduler (lib/smartSortScheduler.js) calls publishDraft/applyRevert on
 * due rules; the routes call them for the explicit buttons. Both paths write
 * the same version history.
 */

const { runSmartRule } = require('./smartCollections');

// The fields that define the ordering — what a draft stages, what a version
// snapshots, what "the config changed" means.
const ORDER_FIELDS = ['slots', 'remainderSortBy', 'pinned', 'removed', 'positions', 'settings'];

const configOf = (rule) => {
  const out = {};
  for (const f of ORDER_FIELDS) out[f] = rule[f] !== undefined ? rule[f] : (f === 'settings' ? {} : []);
  return out;
};

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const unwrap = (result) => (result && result.value !== undefined ? result.value : result);

/**
 * Append a version for the rule's CURRENT live config and stamp
 * rule.liveVersionId. Skips (and returns the latest version's id) when the
 * config is identical to the latest version — repeated curation saves must not
 * flood the history.
 */
async function writeVersion(fastify, rule, source, label) {
  const db = fastify.mongo.db;
  const versionsCol = db.collection('smart_sort_versions');
  const config = configOf(rule);

  const latest = await versionsCol.find({ ruleId: String(rule._id) })
    .sort({ publishedAt: -1 }).limit(1).toArray();
  if (latest[0] && sameConfig(latest[0].config, config)) {
    await db.collection('smart_sort_rules').updateOne(
      { _id: rule._id }, { $set: { liveVersionId: String(latest[0]._id) } });
    return latest[0]._id;
  }

  const doc = {
    ruleId: String(rule._id),
    collectionHandle: rule.collectionHandle,
    label: String(label || '').slice(0, 80),
    source, // 'created' | 'edit' | 'publish' | 'scheduled-publish' | 'restore' | 'revert' | 'baseline'
    config,
    publishedAt: new Date()
  };
  const res = await versionsCol.insertOne(doc);
  await db.collection('smart_sort_rules').updateOne(
    { _id: rule._id }, { $set: { liveVersionId: String(res.insertedId) } });
  return res.insertedId;
}

/**
 * Promote rule.draft to live. Writes the version history, arms the scheduled
 * revert when the draft carries one, clears the draft, and (by default) fires
 * a sync so the new order actually reaches Shopify. Throws when there is no
 * draft.
 */
async function publishDraft(fastify, rule, { trigger = 'manual', sync = true } = {}) {
  const db = fastify.mongo.db;
  const rulesCol = db.collection('smart_sort_rules');
  const draft = rule.draft;
  if (!draft) throw new Error('This smart sort has no draft to publish');

  const $set = { updatedAt: new Date() };
  for (const f of ORDER_FIELDS) if (draft[f] !== undefined) $set[f] = draft[f];
  if (draft.scheduleTime) $set.scheduleTime = draft.scheduleTime;

  // A revert date means: remember the order as it stands RIGHT NOW, and put it
  // back at that time. The baseline version is written before live changes.
  if (draft.revertAt) {
    const baselineId = await writeVersion(fastify, rule, 'baseline',
      'Before ' + (draft.label || 'the draft went live'));
    $set.scheduledRevert = { at: new Date(draft.revertAt), versionId: String(baselineId) };
  }

  const updated = unwrap(await rulesCol.findOneAndUpdate(
    { _id: rule._id },
    { $set, $unset: { draft: '' } },
    { returnDocument: 'after' }
  ));
  if (!updated) throw new Error('Rule not found');

  await writeVersion(fastify, updated,
    trigger === 'schedule' ? 'scheduled-publish' : 'publish', draft.label || '');
  console.log(`[SmartSortVersions] Draft published (${trigger}) for "${updated.collectionHandle}"` +
    ($set.scheduledRevert ? ` — reverts ${$set.scheduledRevert.at.toISOString()}` : ''));

  if (sync) {
    // Detached, with the engine's own concurrency guards; the publish itself
    // must not fail because a sync is already running.
    runSmartRule(fastify, updated, trigger === 'schedule' ? 'schedule' : 'manual').catch((err) => {
      console.error(`[SmartSortVersions] Post-publish sync failed for "${updated.collectionHandle}":`, err.message);
    });
  }
  return updated;
}

/**
 * Apply a due scheduled revert: restore the remembered baseline version to
 * live, clear the schedule, version the restore, sync. A vanished version doc
 * clears the schedule rather than blocking every later tick.
 */
async function applyRevert(fastify, rule) {
  const db = fastify.mongo.db;
  const rulesCol = db.collection('smart_sort_rules');
  const { ObjectId } = require('mongodb');

  const info = rule.scheduledRevert;
  if (!info || !info.versionId) return null;

  let version = null;
  try {
    version = await db.collection('smart_sort_versions').findOne({ _id: new ObjectId(info.versionId) });
  } catch (_) { /* malformed id — treated as missing */ }

  if (!version) {
    console.warn(`[SmartSortVersions] Scheduled revert for "${rule.collectionHandle}" points at a missing version — cleared`);
    await rulesCol.updateOne({ _id: rule._id }, { $unset: { scheduledRevert: '' } });
    return null;
  }

  const updated = unwrap(await rulesCol.findOneAndUpdate(
    { _id: rule._id },
    { $set: { ...version.config, updatedAt: new Date() }, $unset: { scheduledRevert: '' } },
    { returnDocument: 'after' }
  ));
  if (!updated) return null;

  await writeVersion(fastify, updated, 'revert', 'Reverted to the pre-publish order');
  console.log(`[SmartSortVersions] Scheduled revert applied for "${updated.collectionHandle}"`);

  runSmartRule(fastify, updated, 'schedule').catch((err) => {
    console.error(`[SmartSortVersions] Post-revert sync failed for "${updated.collectionHandle}":`, err.message);
  });
  return updated;
}

module.exports = { ORDER_FIELDS, configOf, writeVersion, publishDraft, applyRevert };
