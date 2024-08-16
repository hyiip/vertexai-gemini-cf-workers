const MODELS = {
    "gemini-1.0-pro": {
        vertexName: "gemini-1.0-pro-002",
        region: "us-central1",
    },
    "gemini-1.5-pro-latest": {
        vertexName: "gemini-1.5-pro-001",
        region: "us-central1",
    },
    "gemini-1.5-flash-latest": {
        vertexName: "gemini-1.5-flash-001",
        region: "us-central1",
    },
    "gemini-pro-vision": {
        vertexName: "gemini-1.0-pro-vision-001",
        region: "us-central1",
    }
};

addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    let headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    if (request.method === "OPTIONS") {
        return new Response(null, { headers });
    } else if (request.method === "GET") {
        return createErrorResponse(405, "invalid_request_error", "GET method is not allowed");
    }

    let url = new URL(request.url);
    const apiKey = url.searchParams.get("key");
    if (!API_KEY || API_KEY !== apiKey) {
        return createErrorResponse(401, "authentication_error", "invalid x-api-key");
    }
    url.searchParams.delete("key");
    const signedJWT = await createSignedJWT(CLIENT_EMAIL, PRIVATE_KEY)
    const [token, err] = await exchangeJwtForAccessToken(signedJWT)
    if (token === null) {
        console.log(`Invalid jwt token: ${err}`)
        return createErrorResponse(500, "api_error", "invalid authentication credentials");
    }

    try {
        const normalizedPathname = url.pathname.replace(/^(\/)+/, '/');
        const matchResult = normalizedPathname.match(/^(.*\/)[^/]+$/);
        if (matchResult) {
            const capturedPath = matchResult[1]
            switch(capturedPath) {
              case "/v1/models/":
              case "/v1beta/models/":
                return await handleMessagesEndpoint(request, token, url);
              default:
                return createErrorResponse(404, "not_found_error", "Not Found");
            }
          } else {
            return createErrorResponse(404, "not_found_error", "Not Found");
          }
    } catch (error) {
        console.error(error);
        return createErrorResponse(500, "api_error", "An unexpected error occurred");
    }
}
 
async function handleMessagesEndpoint(request, api_token, originalUrl) {

  // Parse the original path to extract model name and endpoint
  const pathParts = originalUrl.pathname.split('/');
  const modelName = pathParts[pathParts.length - 1].split(':')[0];
  const endpoint = pathParts[pathParts.length - 1].split(':')[1];

  // Check if the model exists in our MODELS object
  if (!MODELS[modelName]) {
    return createErrorResponse(400, "invalid_request_error", `Model '${modelName}' not supported.`);
  }

  const model = MODELS[modelName];

  // Construct the new URL for the Google Cloud AI Platform
  const gcpUrl = `https://${model.region}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${model.region}/publishers/google/models/${model.vertexName}:${endpoint}`;

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return createErrorResponse(400, "invalid_request_error", "The request body is not valid JSON.");
  }

  const fetchOptions = {
    method: request.method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_token}`,
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(payload),
  };

  const fetchUrl = `${gcpUrl}?${originalUrl.searchParams}`;

  try {
    const response = await fetch(fetchUrl, fetchOptions);

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error) {
    return createErrorResponse(500, "api_error", "Server Error");
  }
}

function createErrorResponse(status, errorType, message) {
    const errorObject = { type: "error", error: { type: errorType, message: message } };
    return new Response(JSON.stringify(errorObject), {
        status: status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });
}

async function createSignedJWT(email, pkey) {
    pkey = pkey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n|\\n/g, "");
    let cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        str2ab(atob(pkey)),
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: { name: "SHA-256" },
        },
        false,
        ["sign"]
    );

    const authUrl = "https://www.googleapis.com/oauth2/v4/token";
    const issued = Math.floor(Date.now() / 1000);
    const expires = issued + 600;

    const header = {
        alg: "RS256",
        typ: "JWT",
    };

    const payload = {
        iss: email,
        aud: authUrl,
        iat: issued,
        exp: expires,
        scope: "https://www.googleapis.com/auth/cloud-platform",
    };

    const encodedHeader = urlSafeBase64Encode(JSON.stringify(header));
    const encodedPayload = urlSafeBase64Encode(JSON.stringify(payload));

    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        str2ab(unsignedToken)
    );

    const encodedSignature = urlSafeBase64Encode(signature);
    return `${unsignedToken}.${encodedSignature}`;
}

async function exchangeJwtForAccessToken(signed_jwt) {
    const auth_url = "https://www.googleapis.com/oauth2/v4/token";
    const params = {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signed_jwt,
    };

    const r = await fetch(auth_url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: Object.entries(params)
            .map(([k, v]) => k + "=" + v)
            .join("&"),
    }).then((res) => res.json());

    if (r.access_token) {
        return [r.access_token, ""];
    }

    return [null, JSON.stringify(r)];
}

function str2ab(str) {
    const buffer = new ArrayBuffer(str.length);
    let bufferView = new Uint8Array(buffer);
    for (let i = 0; i < str.length; i++) {
        bufferView[i] = str.charCodeAt(i);
    }
    return buffer;
}

function urlSafeBase64Encode(data) {
    let base64 = typeof data === "string" ? btoa(encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1)))) : btoa(String.fromCharCode(...new Uint8Array(data)));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
