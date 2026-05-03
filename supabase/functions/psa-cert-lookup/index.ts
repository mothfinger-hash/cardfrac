// Supabase Edge Function: psa-cert-lookup
// Proxies PSA Public API cert lookups so the token never touches the browser.
//
// Deploy:
//   supabase secrets set PSA_TOKEN=<your_token>
//   supabase functions deploy psa-cert-lookup
//
// The function requires the caller to be authenticated (valid Supabase session).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PSA_API = 'https://api.psacard.com/publicapi/cert/GetByCertNumber';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify the caller has a valid Supabase session
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Parse request body
    const { certNumber } = await req.json();
    if (!certNumber || typeof certNumber !== 'string') {
      return new Response(JSON.stringify({ error: 'certNumber is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Sanitise — cert numbers are digits only
    const clean = certNumber.replace(/\D/g, '');
    if (!clean) {
      return new Response(JSON.stringify({ error: 'Invalid cert number format' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const psaToken = Deno.env.get('PSA_TOKEN');
    if (!psaToken) {
      return new Response(JSON.stringify({ error: 'PSA_TOKEN secret not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Call PSA API
    const psaRes = await fetch(`${PSA_API}/${clean}`, {
      headers: {
        'Authorization': `Bearer ${psaToken}`,
        'Accept': 'application/json',
      }
    });

    if (!psaRes.ok) {
      const txt = await psaRes.text();
      console.error('[psa-cert-lookup] PSA API error:', psaRes.status, txt);
      if (psaRes.status === 404) {
        return new Response(JSON.stringify({ error: 'Cert not found' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: 'PSA API error', status: psaRes.status }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const psaData = await psaRes.json();
    const cert = psaData?.PSACert;

    if (!cert) {
      return new Response(JSON.stringify({ error: 'No cert data returned' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Return a clean, normalised payload to the client
    return new Response(JSON.stringify({
      certNumber:  cert.CertNumber    || clean,
      grade:       cert.CardGrade     || null,   // e.g. "10", "9.5"
      gradeDesc:   cert.GradeDescription || null, // e.g. "GEM MT 10"
      cardName:    cert.Subject       || null,
      year:        cert.Year          || null,
      brand:       cert.Brand         || null,
      variety:     cert.Variety       || null,
      imageUrl:    cert.ImageFront    || cert.ImageBack || null,
      imageBack:   cert.ImageBack     || null,
      cardNumber:  cert.CardNumber    || null,
      specUrl:     `https://www.psacard.com/cert/${clean}`,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[psa-cert-lookup] Unexpected error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
