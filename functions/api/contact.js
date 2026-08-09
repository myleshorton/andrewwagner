// The real site backs this route with a Next API handler. A static mirror has
// no backend, so the form's on-mount CSRF fetch would receive HTML and throw a
// JSON parse error on every page load.
//
// GET returns a well-formed token so the component initialises cleanly.
// POST deliberately does NOT accept the message: this is a performance preview,
// and silently swallowing an enquiry meant for the architect would be worse
// than failing loudly.
export async function onRequestGet() {
  return Response.json({ csrf: crypto.randomUUID() });
}

export async function onRequestPost() {
  return Response.json(
    {
      ok: false,
      error: "This is a performance preview of the site. The contact form is not connected.",
    },
    { status: 503 },
  );
}
