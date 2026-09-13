const realServe = Deno.serve;
// Supabase permits reading environment variables but rejects writes.
Deno.env.set = () => {
  throw new Error('Hosted environment variables are read-only.');
};
Deno.serve = ((handler: Parameters<typeof realServe>[0]) =>
  realServe(
    { hostname: '127.0.0.1', port: Number(Deno.env.get('ORDERLY_TEST_PORT')) },
    handler,
  )) as typeof realServe;
await import('../supabase/functions/orderly/index.js');
