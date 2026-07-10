export async function onRequest(context: { request: Request }) {
  const { request } = context;
  const url = new URL(request.url);
  const apiUrl = `https://ai-video.ldragon.xyz${url.pathname}${url.search}`;
  
  const headers = new Headers(request.headers);
  headers.set('Host', 'ai-video.ldragon.xyz');
  
  const newRequest = new Request(apiUrl, {
    method: request.method,
    headers: headers,
    body: request.body,
    redirect: 'follow',
  });
  
  const response = await fetch(newRequest);
  
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      ...response.headers,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
  
  return newResponse;
}
