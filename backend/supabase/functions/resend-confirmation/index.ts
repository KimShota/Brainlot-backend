import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type Body = { email: string };

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

console.log("🚀 Deployed resend-confirmation function is running");

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "This method is not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const { email }: Body = await req.json();
    
    if (!email) {
      return new Response(
        JSON.stringify({ ok: false, error: "Email is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid email format" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with service role key for admin operations
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    console.log("📧 Resending confirmation email for:", email);

    // Use Admin API to resend confirmation email
    // First, check if user exists and is unconfirmed
    const { data: users, error: userError } = await supabaseAdmin.auth.admin.listUsers();
    
    if (userError) {
      console.error("❌ Error fetching users:", userError);
      return new Response(
        JSON.stringify({ ok: false, error: "Failed to check user status" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const user = users.users.find(u => u.email === email);
    
    if (!user) {
      return new Response(
        JSON.stringify({ ok: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (user.email_confirmed_at) {
      return new Response(
        JSON.stringify({ ok: false, error: "Email is already confirmed" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generate a new confirmation link
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'signup',
      email: email,
    });

    if (error) {
      console.error("❌ Error generating confirmation link:", error);
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Confirmation link generated successfully");

    // Send the confirmation email using Admin API
    const { error: sendError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: data.properties?.action_link,
    });

    if (sendError) {
      console.error("❌ Error sending confirmation email:", sendError);
      return new Response(
        JSON.stringify({ ok: false, error: sendError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("✅ Confirmation email sent successfully");

    return new Response(
      JSON.stringify({ 
        ok: true, 
        message: "Confirmation email sent successfully" 
      }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (e) {
    console.error("Edge function error:", e);
    console.error("Error stack:", e.stack);
    console.error("Error message:", e.message);
    
    const errorMessage = e.message || String(e);
    
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
