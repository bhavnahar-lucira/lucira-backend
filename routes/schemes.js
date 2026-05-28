let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const { ORN_TOKEN_URL, ORN_USERNAME, ORN_PASSWORD } = process.env;

  const body = new URLSearchParams();
  body.append('grant_type', 'password');
  body.append('client_id', 'api_access');
  body.append('scope', 'openid offline_access');
  body.append('username', ORN_USERNAME);
  body.append('password', ORN_PASSWORD);

  const res = await fetch(ORN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Token fetch failed (' + res.status + '): ' + errText);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchSchemes(token, mobile) {
  const { ORN_LIST_URL } = process.env;

  const res = await fetch(ORN_LIST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ mobile })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Enrollment fetch failed (' + res.status + '): ' + errText);
  }

  const data = await res.json();
  return data.Entities || [];
}

module.exports = async function (fastify, opts) {
  fastify.post('/', async (request, reply) => {
    const { mobile } = request.body || {};
    
    if (!mobile) {
      return reply.code(400).send({ error: "Mobile number is required" });
    }

    try {
      const token = await getToken();
      const schemes = await fetchSchemes(token, mobile);
      return { schemes };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: "Failed to fetch schemes", details: err.message });
    }
  });
};
