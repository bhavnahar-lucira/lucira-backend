const cachedData = {
  token: null,
  expiry: 0
};

async function getORNToken() {
  if (cachedData.token && Date.now() < cachedData.expiry) {
    return cachedData.token;
  }

  const { ORN_TOKEN_URL, ORN_CLIENT_ID, ORN_SECRET, ORN_USERNAME, ORN_PASSWORD } = process.env;

  if (!ORN_TOKEN_URL || !ORN_CLIENT_ID || !ORN_SECRET) {
    throw new Error('Ornaverse credentials missing in environment (ORN_TOKEN_URL, ORN_CLIENT_ID, ORN_SECRET required)');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: ORN_CLIENT_ID,
    client_secret: ORN_SECRET,
    scope: 'profile email',
    username: ORN_USERNAME,
    password: ORN_PASSWORD,
  });

  const res = await fetch(ORN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Ornaverse token fetch failed (' + res.status + '): ' + errText);
  }

  const data = await res.json();
  cachedData.token = data.access_token;
  cachedData.expiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedData.token;
}

async function ornaverseFetch(endpoint, method = 'POST', body = null) {
  const token = await getORNToken();
  const baseUrl = process.env.ORN_TOKEN_URL.replace('/connect/token', '');
  const url = `${baseUrl}${endpoint}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    console.error(`Ornaverse API Error [${endpoint}]:`, data);
    const error = new Error(data.error || `Ornaverse API failed: ${res.status}`);
    error.status = res.status;
    error.details = data;
    throw error;
  }

  return data;
}

module.exports = {
  getORNToken,
  ornaverseFetch
};
