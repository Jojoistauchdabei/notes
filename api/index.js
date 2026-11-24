// Cloudflare Worker → PocketBase Backend
// Auth, CRUD, and Sync endpoints

const POCKETBASE_URL = 'https://federwerk.ponnet.org';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route: /api/auth/login
      if (path === '/api/auth/login' && request.method === 'POST') {
        const { email, password } = await request.json();
        const res = await fetch(`${POCKETBASE_URL}/api/collections/users/auth-with-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: email, password }),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Route: /api/auth/register
      if (path === '/api/auth/register' && request.method === 'POST') {
        const body = await request.json();
        const res = await fetch(`${POCKETBASE_URL}/api/collections/users/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Route: /api/documents (GET - list, POST - create)
      if (path === '/api/documents') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'GET') {
          const res = await fetch(`${POCKETBASE_URL}/api/collections/documents/records`, {
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'POST') {
          const body = await request.json();
          const res = await fetch(`${POCKETBASE_URL}/api/collections/documents/records`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            status: res.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Route: /api/documents/:id (GET, PUT, DELETE)
      const docMatch = path.match(/^\/api\/documents\/(.+)$/);
      if (docMatch) {
        const docId = docMatch[1];
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const pbUrl = `${POCKETBASE_URL}/api/collections/documents/records/${docId}`;

        if (request.method === 'GET') {
          const res = await fetch(pbUrl, { headers: { 'Authorization': `Bearer ${token}` } });
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'PUT') {
          const body = await request.json();
          const res = await fetch(pbUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'DELETE') {
          const res = await fetch(pbUrl, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          return new Response(null, { status: res.status, headers: corsHeaders });
        }
      }

      // Route: /api/sync (POST - push changes)
      if (path === '/api/sync' && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (!token) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { changes } = await request.json();
        const results = [];

        for (const change of changes) {
          const { action, collection, record } = change;
          const pbUrl = `${POCKETBASE_URL}/api/collections/${collection}/records${record.id ? '/' + record.id : ''}`;

          let res;
          if (action === 'create') {
            res = await fetch(pbUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify(record),
            });
          } else if (action === 'update') {
            res = await fetch(pbUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify(record),
            });
          } else if (action === 'delete') {
            res = await fetch(pbUrl, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` },
            });
          }

          results.push({ id: record.id, status: res.status });
        }

        return new Response(JSON.stringify({ results }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};