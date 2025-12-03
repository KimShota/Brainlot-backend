import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Body = {
  file_data?: string;
  mime_type?: string;
  text_content?: string;
  content_type?: string;
  llm_provider?: string;
  mcq_count?: number;
  text_chunks?: string[];
};

const MAX_INPUT_LENGTH = 2500;
const MAX_OUTPUT_TOKENS = 1500;

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const GROQ_MODEL = "llama-3.1-8b-instant";

async function callGroqWithText(
  textContent: string,
  prompt: string,
  maxRetries = 3
): Promise<{ 
  content: string; 
  usage: any;
}> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in the environment");
  }

  // Enforce maximum input length
  const limitedTextContent =
    textContent.length > MAX_INPUT_LENGTH
      ? textContent.slice(0, MAX_INPUT_LENGTH)
      : textContent;

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
        content: `${prompt}\n\nSTUDY MATERIAL:\n${limitedTextContent}`,
      },
    ],
    response_format: {type: "json_object"},
    temperature: 0.2,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
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

      let rawResponse: string | null = null;
      
      if (!res.ok) {
        const errorText = await res.text();
        rawResponse = errorText;
        if (res.status >= 500 && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        const error: any = new Error(`Groq API failed: ${errorText}`);
        error.rawResponse = errorText;
        error.statusCode = res.status;
        throw error;
      }

      const responseText = await res.text();
      rawResponse = responseText;
      const data = JSON.parse(responseText);
      const content =
        data.choices?.[0]?.message?.content ??
        data.choices?.[0]?.message?.content?.[0]?.text ??
        "[]";
      const usage = data.usage ?? {};
      const completionTokens = usage.completion_tokens ?? 0;
      
      // Log token usage for monitoring (no truncation)
      if (completionTokens > MAX_OUTPUT_TOKENS) {
        console.warn(
          `⚠️ Response exceeded token limit: ${completionTokens} > ${MAX_OUTPUT_TOKENS}`
        );
      }
      
      return { content, usage };
    } catch (error: any) {
      if (attempt === maxRetries) {
        // Preserve raw response in error if it exists
        if (error.rawResponse) {
          throw error;
        }
        // If error doesn't have rawResponse, try to add it
        if (error.message && !error.rawResponse) {
          error.rawResponse = error.message;
        }
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

    const { text_content, mcq_count, text_chunks }: Body = await req.json();

    const sanitizedChunks =
      text_chunks
        ?.filter((chunk): chunk is string => typeof chunk === "string")
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0) ?? [];

    const primaryText = text_content?.trim();

    if ((!primaryText || primaryText.length === 0) && sanitizedChunks.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "text_content or text_chunks is required",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const count = mcq_count ?? 20;

    const studyMaterialSections = (sanitizedChunks.length ? sanitizedChunks : [primaryText!])
      .map(
        (chunk, index) =>
          `STUDY MATERIAL SECTION ${index + 1}:\n${chunk}`
      )
      .join("\n\n");

    const prompt = `
You are an expert MCQ generator. Create ${count} high-quality multiple-choice questions that test users' understanding and knowledge of the concepts, facts, and ideas covered in the study material.

CRITICAL REQUIREMENTS:
1. Questions MUST test understanding and knowledge of concepts, facts, and ideas - NOT retrieval of specific text passages
2. Questions must be answerable from MEMORY and COMPREHENSION - users should NOT need to look back at the material
3. NEVER use words like "text", "document", "passage", "material", "according to", "mentioned", "stated", "explained", "notes", or "discusses" in the question itself
4. Focus on testing KNOWLEDGE and UNDERSTANDING of the subject matter, not memory of specific wording
5. Each question must have exactly 4 options
6. Include "answer_index" (0-based index) for the correct answer
7. Respond with a valid JSON object containing a "mcqs" key with an array of MCQ objects - no markdown, no code blocks, no additional text
8. Format: {"mcqs": [array of MCQ objects]}

GOOD EXAMPLES:
{ "question": "What is the resolving power of a light microscope?", "options": ["0.2 nm", "200 nm", "2 μm", "0.2 μm"], "answer_index": 1 }
{ "question": "Which process occurs during photosynthesis?", "options": ["Glucose breakdown", "Carbon dioxide absorption", "Protein synthesis", "DNA replication"], "answer_index": 1 }
{ "question": "What is the chemical formula for water?", "options": ["H2O", "CO2", "NaCl", "O2"], "answer_index": 0 }
{ "question": "Who was the first African American to serve in the U.S. Senate?", "options": ["Frederick Douglass", "Hiram Revels", "Booker T. Washington", "W.E.B. Du Bois"], "answer_index": 1 }
{ "question": "What type of sound sources exist besides musical instruments and traffic?", "options": ["Electronic devices", "Natural phenomena", "Human voices", "Animal sounds"], "answer_index": 1 }
{ "question": "How does the speed of sound change with temperature?", "options": ["Increases by 0.6 m/s per °C", "Decreases by 0.6 m/s per °C", "Remains constant", "Increases by 3.31 m/s per °C"], "answer_index": 0 }
`;

    const { 
      content: groqRaw, 
      usage 
    } = await callGroqWithText(studyMaterialSections, prompt);

    let mcqs: any[] = [];
    try {
      // First, try parsing as JSON (could be array or object)
      const parsed = JSON.parse(groqRaw);
      
      // If it's already an array, use it directly
      if (Array.isArray(parsed)) {
        mcqs = parsed;
      } 
      // If it's an object, try to extract the array from common keys
      else if (typeof parsed === 'object' && parsed !== null) {
        // Try common keys that might contain the MCQ array
        const possibleKeys = ['mcqs', 'questions', 'items', 'data', 'results', 'array'];
        for (const key of possibleKeys) {
          if (Array.isArray(parsed[key])) {
            mcqs = parsed[key];
            break;
          }
        }
        
        // If no array found in common keys, check if any value is an array
        if (mcqs.length === 0) {
          for (const value of Object.values(parsed)) {
            if (Array.isArray(value)) {
              mcqs = value;
              break;
            }
          }
        }
        
        // If still no array found, throw error
        if (mcqs.length === 0) {
          const error: any = new Error("Could not find MCQ array in JSON object response");
          error.rawResponse = groqRaw;
          throw error;
        }
      } else {
        const error: any = new Error("Parsed JSON is neither an array nor an object");
        error.rawResponse = groqRaw;
        throw error;
      }
    } catch (parseError: any) {
      // If JSON parsing failed, try to extract array from text
      try {
        const jsonMatch = groqRaw.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch && jsonMatch[0]) {
          mcqs = JSON.parse(jsonMatch[0]);
        } else {
          const error: any = new Error("Could not extract JSON from response");
          error.rawResponse = groqRaw;
          throw error;
        }
      } catch (extractError: any) {
        const error: any = new Error("Groq did not return valid JSON");
        error.rawResponse = groqRaw;
        throw error;
      }
    }

    if (!Array.isArray(mcqs)) {
      const error: any = new Error("Groq response is not an array");
      error.rawResponse = groqRaw;
      throw error;
    }

    // Log token usage for monitoring (no truncation)
    const completionTokens = usage?.completion_tokens ?? 0;
    if (completionTokens > MAX_OUTPUT_TOKENS) {
      console.warn(
        `⚠️ Token limit exceeded: ${completionTokens} tokens used (limit: ${MAX_OUTPUT_TOKENS})`
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        mcqs,
        generated_at: new Date().toISOString(),
        count: mcqs.length,
        model: GROQ_MODEL,
        usage,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
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

    // Include raw response from LLM API if available
    const errorResponse: any = {
      ok: false,
      error: userMessage,
    };

    if (e.rawResponse) {
      errorResponse.raw_api_response = e.rawResponse;
    }

    if (e.statusCode) {
      errorResponse.status_code = e.statusCode;
    }

    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
