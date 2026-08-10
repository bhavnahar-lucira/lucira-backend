// let cachedToken = null;
// let tokenExpiry = 0;

// async function getToken() {
//   if (cachedToken && Date.now() < tokenExpiry) {
//     return cachedToken;
//   }

//   const { ORN_TOKEN_URL, ORN_USERNAME, ORN_PASSWORD } = process.env;

//   const body = new URLSearchParams();
//   body.append('grant_type', 'client_credentials');
//   body.append('client_id', 'ff15960083ee4b4694bfb918e56c13c6');
//   body.append('scope', 'profile email');
//   body.append('client_secret', '56F726E0A0CABB34CF0462545D3D53E90824B5181A26B50B9C162335DDD6BAC3');

//   const res = await fetch(ORN_TOKEN_URL, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
//     body: body.toString()
//   });

//   if (!res.ok) {
//     const errText = await res.text();
//     throw new Error('Token fetch failed (' + res.status + '): ' + errText);
//   }

//   const data = await res.json();
//   cachedToken = data.access_token;
//   tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
//   return cachedToken;
// }

const ORN_TOKEN_URL = "https://lucira.live.ornaverse.in/connect/token";
const ORN_BASE_URL = "https://lucira.live.ornaverse.in";

let cachedToken = null;
let tokenExpiry = 0;


async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    'grant_type': 'client_credentials',
    'client_id': process.env.ORN_CLIENT_ID,
    'scope': 'profile email',
    'client_secret': process.env.ORN_SECRET,
    username: process.env.ORN_USERNAME,
    password: process.env.ORN_PASSWORD,
  });

  const res = await fetch(ORN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('ORN token error(${ res.status }): ${ txt }');
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
