import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REVENUECAT_SECRET_KEY = Deno.env.get("REVENUECAT_SECRET_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

interface RequestBody {
  revenue_cat_customer_id: string;
  revenue_cat_subscription_id?: string | null;
  entitlement_data?: {
    identifier?: string;
    will_renew?: boolean | string | null;
    expiration_date?: string;
  } | null;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    // 認証チェック
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Missing or invalid token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Invalid token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("✅ User authenticated:", user.id);

    // リクエストボディを取得
    const body: RequestBody = await req.json();
    const { revenue_cat_customer_id, revenue_cat_subscription_id, entitlement_data } = body;

    if (!revenue_cat_customer_id) {
      return new Response(
        JSON.stringify({ ok: false, error: "revenue_cat_customer_id is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // RevenueCat APIで購入を検証
    let isProActive = false;
    
    if (REVENUECAT_SECRET_KEY) {
      try {
        const revenueCatResponse = await fetch(
          `https://api.revenuecat.com/v1/subscribers/${revenue_cat_customer_id}`,
          {
            headers: {
              "Authorization": `Bearer ${REVENUECAT_SECRET_KEY}`,
              "X-Platform": "ios", // または "android"
            },
          }
        );

        if (revenueCatResponse.ok) {
          const revenueCatData = await revenueCatResponse.json();
          
          // Proエンタイトルメントをチェック
          const subscriber = revenueCatData.subscriber;
          const proEntitlement = subscriber?.entitlements?.pro || 
                                subscriber?.entitlements?.Pro ||
                                subscriber?.entitlements?.PRO ||
                                Object.values(subscriber?.entitlements?.active || {}).find(
                                  (ent: any) => 
                                    ent.identifier?.toLowerCase().includes('pro') ||
                                    ent.product_identifier?.toLowerCase().includes('pro')
                                );

          if (proEntitlement) {
            const willRenew = proEntitlement.will_renew === true || 
                            proEntitlement.will_renew === 'true';
            const expirationDate = proEntitlement.expires_date;
            const now = new Date();
            const isNotExpired = expirationDate ? new Date(expirationDate) > now : false;
            
            isProActive = willRenew || isNotExpired;
          }

          console.log(`✅ RevenueCat verification: isProActive=${isProActive}`);
        } else {
          console.warn(`⚠️ RevenueCat API returned ${revenueCatResponse.status}`);
          // RevenueCat APIが失敗した場合、フロントエンドから送られてきたentitlement_dataを使用
          if (entitlement_data) {
            const willRenew = entitlement_data.will_renew === true || 
                            entitlement_data.will_renew === 'true';
            const expirationDate = entitlement_data.expiration_date;
            const now = new Date();
            const isNotExpired = expirationDate ? new Date(expirationDate) > now : false;
            isProActive = willRenew || isNotExpired;
          }
        }
      } catch (rcError: any) {
        console.error('Error calling RevenueCat API:', rcError);
        // RevenueCat APIが失敗した場合、フロントエンドから送られてきたentitlement_dataを使用
        if (entitlement_data) {
          const willRenew = entitlement_data.will_renew === true || 
                          entitlement_data.will_renew === 'true';
          const expirationDate = entitlement_data.expiration_date;
          const now = new Date();
          const isNotExpired = expirationDate ? new Date(expirationDate) > now : false;
          isProActive = willRenew || isNotExpired;
        }
      }
    } else {
      console.warn('⚠️ REVENUECAT_SECRET_KEY not set, using entitlement_data from frontend');
      // REVENUECAT_SECRET_KEYが設定されていない場合、フロントエンドから送られてきたentitlement_dataを使用
      if (entitlement_data) {
        const willRenew = entitlement_data.will_renew === true || 
                        entitlement_data.will_renew === 'true';
        const expirationDate = entitlement_data.expiration_date;
        const now = new Date();
        const isNotExpired = expirationDate ? new Date(expirationDate) > now : false;
        isProActive = willRenew || isNotExpired;
      }
    }

    // RPC関数を呼び出してサブスクリプションを更新
    // 注意: isProActiveの判定はRevenueCat APIの結果に基づいていますが、
    // RPC関数内ではrevenue_cat_customer_idの存在のみをチェックします
    // 実際のPro判定は、RevenueCat APIの検証結果（isProActive）を使用します
    const { data: rpcData, error: rpcError } = await supabaseClient.rpc('sync_user_subscription', {
      revenue_cat_customer_id: revenue_cat_customer_id,
      revenue_cat_subscription_id: revenue_cat_subscription_id || null,
      is_pro_active: isProActive, 
    });

    if (rpcError) {
      console.error('Error calling sync_user_subscription RPC:', rpcError);
      return new Response(
        JSON.stringify({ ok: false, error: `Failed to sync subscription: ${rpcError.message}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // RPC関数の結果を返す（plan_typeとstatusはRPC関数内で決定されますが、
    // RevenueCat APIの検証結果を優先するため、ここで上書きします）
    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          plan_type: isProActive ? 'pro' : 'free',
          status: isProActive ? 'active' : 'cancelled',
          ...rpcData,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error('Error in sync-subscription:', e);
    return new Response(
      JSON.stringify({
        ok: false,
        error: e.message || "An unexpected error occurred. Please try again later.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});