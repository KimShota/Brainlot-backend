import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Body = {
  file_data?: string;
  mime_type?: string;
  text_content?: string;
  content_type?: string;
  llm_provider?: string;
  mcq_count?: number;
};

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const GROQ_MODEL = "llama-3.1-8b-instant";

async function callGroqWithText(
  textContent: string,
  prompt: string,
  maxRetries = 3
) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in the environment");
  }

  const body = {
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are an expert MCQ generator. You ONLY respond with a JSON array of MCQ objects as instructed.",
      },
      {
        role: "user",
        content: `${prompt}\n\nSTUDY MATERIAL:\n${textContent}`,
      },
    ],
    temperature: 0.2,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_API_KEY}`,
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        if (res.status >= 500 && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        throw new Error(`Groq API failed: ${errorText}`);
      }

      const data = await res.json();
      const content =
        data.choices?.[0]?.message?.content ??
        data.choices?.[0]?.message?.content?.[0]?.text ??
        "[]";
      return content;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ ok: false, error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Unauthorized: Missing or invalid token",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
      auth: {
        persistSession: false,
      },
    });

    const {
      data: { user },
      error: authError,
    } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Invalid token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const { text_content, mcq_count }: Body = await req.json();

    if (!text_content) {
      return new Response(
        JSON.stringify({ ok: false, error: "text_content is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const count = mcq_count && mcq_count > 0 ? mcq_count : 30;

    const prompt = `
You are an expert MCQ generator. Create ${count} high-quality multiple-choice questions that test users' understanding and knowledge of the concepts, facts, and ideas covered in the study material.

CRITICAL REQUIREMENTS:
1. Questions MUST test understanding and knowledge of concepts, facts, and ideas - NOT retrieval of specific text passages
2. Questions must be answerable from MEMORY and COMPREHENSION - users should NOT need to look back at the material
3. NEVER use words like "text", "document", "passage", "material", "according to", "mentioned", "stated", "explained", "notes", or "discusses" in the question itself
4. Focus on testing KNOWLEDGE and UNDERSTANDING of the subject matter, not memory of specific wording
5. Each question must have exactly 4 options
6. Include "answer_index" (0-based index) for the correct answer
7. Respond ONLY with a valid JSON array - no markdown, no code blocks, no additional text
`;

    const groqRaw = await callGroqWithText(text_content, prompt);

    let mcqs: any[] = [];
    try {
      mcqs = JSON.parse(groqRaw);
    } catch {
      try {
        const jsonMatch = groqRaw.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch && jsonMatch[0]) {
          mcqs = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("Could not extract JSON from response");
        }
      } catch (parseError) {
        throw new Error(
          "Groq did not return valid JSON. Raw response: " + groqRaw
        );
      }
    }

    if (!Array.isArray(mcqs)) {
      throw new Error("Groq response is not an array: " + groqRaw);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mcqs,
        generated_at: new Date().toISOString(),
        count: mcqs.length,
        model: GROQ_MODEL,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    const isDevelopment = Deno.env.get("ENVIRONMENT") === "development";
    let userMessage = "An unexpected error occurred. Please try again later.";

    if (isDevelopment) {
      userMessage = e.message || String(e);
    } else {
      if (e.message?.includes("Groq API")) {
        userMessage =
          "AI service is temporarily unavailable. Please try again later.";
      } else if (e.message?.includes("not authenticated")) {
        userMessage = "Authentication failed. Please log in again.";
      } else if (e.message?.includes("Failed to fetch")) {
        userMessage =
          "Network error. Please check your connection and try again.";
      } else if (e.message?.includes("JSON")) {
        userMessage = "Failed to process AI response. Please try again.";
      }
    }

    return new Response(JSON.stringify({ ok: false, error: userMessage }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
