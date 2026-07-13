// Server-to-server proxy for Nitro's "Contact Details" identity API.
//
// The Bearer token is partner-specific and sensitive, so it must never reach the
// browser. It lives in server env and this route is the only thing that uses it.
//
// Required env:
//   NITRO_ORG_ID  -> the <org_id> path segment
//   NITRO_TOKEN   -> the Bearer token
//
// Docs: GET https://t.makehook.ws/jsv1/contact-details/<org_id>/<parent_id>/<nitro_id>
//       Authorization: Bearer <token>
// Response: { identified_data: { email, phone, consent_data: { is_phone_consented,
//             is_email_consented }, pincode, address }, code, message }

const NITRO_BASE = "https://t.makehook.ws/jsv1/contact-details";

// Normalize any string to a valid 10-digit Indian mobile (or null).
function normalizeIndianMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.slice(-10); // strip a leading 91 / 0 etc.
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

async function routes(fastify, options) {
  // GET /api/nitro/contact-details?nitroId=...&parentId=...
  fastify.get("/contact-details", async (request, reply) => {
    const token = process.env.NITRO_TOKEN;
    const orgId = process.env.NITRO_ORG_ID;

    // Best-effort: if not configured, fail quietly so the auth form still works.
    if (!token || !orgId) {
      return { phone: null, email: null, reason: "not_configured" };
    }

    const nitroId = request.query.nitroId?.trim();
    const parentId = request.query.parentId?.trim(); // roaming_id

    if (!nitroId || !parentId) {
      return reply
        .code(400)
        .send({ phone: null, email: null, reason: "missing_ids" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const upstream = await fetch(
        `${NITRO_BASE}/${encodeURIComponent(orgId)}/${encodeURIComponent(
          parentId
        )}/${encodeURIComponent(nitroId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }
      );

      clearTimeout(timeout);

      if (!upstream.ok) {
        return {
          phone: null,
          email: null,
          reason: "upstream_error",
          status: upstream.status,
        };
      }

      const data = await upstream.json();
      const identified = data?.identified_data || {};
      const consent = identified.consent_data || {};

      const phone = normalizeIndianMobile(identified.phone);
      const email =
        typeof identified.email === "string" && identified.email.includes("@")
          ? identified.email
          : null;

      // Only the resolved PII leaves the server — not the raw upstream payload.
      reply.header("Cache-Control", "no-store"); // per-visitor, never cache
      return {
        phone,
        email,
        isPhoneConsented: !!consent.is_phone_consented,
        isEmailConsented: !!consent.is_email_consented,
      };
    } catch (error) {
      clearTimeout(timeout);
      fastify.log.error(error);
      return { phone: null, email: null, reason: "fetch_failed" };
    }
  });
}

module.exports = routes;
