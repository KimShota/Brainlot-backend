import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Body = { 
  file_data?: string; 
  mime_type?: string;
  text_content?: string;
  content_type?: string;
};

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Global usage tracking
let globalUsageCount = 0;
let globalUsageResetTime = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
const MAX_GLOBAL_USAGE = 500000; // Supabase free tier limit

// Rate limiting storage (in-memory)
const rateLimitMap = new Map<string, { count: number, resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per hour per user

// User subscription limits (daily only)
const USER_LIMITS = {
  FREE: {
    daily_limit: 5      // 5 files per day
  },
  PRO: {
    daily_limit: 50     // 50 files per day
  }
};

// Cache for storing MCQs temporarily (in-memory)
const mcqCache = new Map<string, { mcqs: any[], timestamp: number }>();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

console.log("🚀 Deployed generate-mcqs function (Stateless Architecture with Usage Monitoring)");

/**
 * Check global usage limit
 */
function checkGlobalUsage(): { allowed: boolean, remaining: number, resetTime: number } {
  const now = Date.now();
  
  // Reset counter monthly
  if (now > globalUsageResetTime) {
    globalUsageCount = 0;
    globalUsageResetTime = now + (30 * 24 * 60 * 60 * 1000);
  }
  
  if (globalUsageCount >= MAX_GLOBAL_USAGE) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: globalUsageResetTime
    };
  }
  
  return {
    allowed: true,
    remaining: MAX_GLOBAL_USAGE - globalUsageCount,
    resetTime: globalUsageResetTime
  };
}

/**
 * Increment global usage counter
 */
function incrementGlobalUsage(): void {
  globalUsageCount++;
  console.log(`📊 Global usage: ${globalUsageCount}/${MAX_GLOBAL_USAGE}`);
}

/**
 * Get user subscription status from database
 */
async function getUserSubscription(userId: string, supabaseClient: any): Promise<'FREE' | 'PRO'> {
  try {
    const { data, error } = await supabaseClient
      .from('user_subscriptions')
      .select('plan_type, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();
    
    if (error || !data) {
      return 'FREE'; // Default to free if no subscription found
    }
    
    // Map plan_type to subscription level
    return data.plan_type === 'pro' ? 'PRO' : 'FREE';
  } catch (error) {
    console.error('Error fetching user subscription:', error);
    return 'FREE';
  }
}

/**
 * Get user usage stats from database (daily limit only)
 */
async function getUserUsageStatsFromDB(userId: string, supabaseClient: any): Promise<{
  uploads_today: number;
  daily_reset_at: string;
}> {
  try {
    // Use RPC function to get stats (automatically checks and resets if needed)
    const { data, error } = await supabaseClient.rpc('get_user_usage_stats', {
      user_id_param: userId,
    });

    if (error) {
      console.error('Error fetching usage stats from RPC:', error);
      // Fallback to direct query
      const { data: fallbackData, error: fallbackError } = await supabaseClient
        .from('user_usage_stats')
        .select('uploads_today, daily_reset_at')
        .eq('user_id', userId)
        .single();

      if (fallbackError) {
        console.error('Error fetching usage stats (fallback):', fallbackError);
        // Return defaults if record doesn't exist
        return {
          uploads_today: 0,
          daily_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
      }

      return {
        uploads_today: fallbackData.uploads_today || 0,
        daily_reset_at: fallbackData.daily_reset_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    if (data && data.length > 0) {
      return {
        uploads_today: data[0].uploads_today || 0,
        daily_reset_at: data[0].daily_reset_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    // Default if no data
    return {
      uploads_today: 0,
      daily_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch (error) {
    console.error('Error in getUserUsageStatsFromDB:', error);
    return {
      uploads_today: 0,
      daily_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
}

/**
 * Check user-specific limits (daily only) using database
 */
async function checkUserLimits(
  userId: string, 
  subscription: 'FREE' | 'PRO',
  supabaseClient: any
): Promise<{
  allowed: boolean;
  limitType: 'daily' | null;
  remaining: number;
  resetTime: number;
}> {
  const limits = USER_LIMITS[subscription];
  
  // Get usage stats from database
  const usage = await getUserUsageStatsFromDB(userId, supabaseClient);
  
  // Check daily limit only
  if (usage.uploads_today >= limits.daily_limit) {
    return {
      allowed: false,
      limitType: 'daily',
      remaining: 0,
      resetTime: new Date(usage.daily_reset_at).getTime(),
    };
  }
  
  // Daily limit passed
  return {
    allowed: true,
    limitType: null,
    remaining: limits.daily_limit - usage.uploads_today,
    resetTime: new Date(usage.daily_reset_at).getTime(),
  };
}

/**
 * Increment user usage counters in database
 */
async function incrementUserUsage(userId: string, supabaseClient: any): Promise<void> {
  try {
    // Use RPC function to increment (automatically handles daily reset)
    const { error } = await supabaseClient.rpc('increment_upload_count', {
      user_id_param: userId,
    });

    if (error) {
      console.error('Error incrementing upload count via RPC:', error);
      // Fallback to manual update (daily limit only)
      const { data: current } = await supabaseClient
        .from('user_usage_stats')
        .select('uploads_today, daily_reset_at')
        .eq('user_id', userId)
        .single();

      if (current) {
        const now = new Date();
        const resetAt = new Date(current.daily_reset_at);
        
        // Check if daily reset is needed
        if (now >= resetAt) {
          await supabaseClient
            .from('user_usage_stats')
            .update({
              uploads_today: 1,
              daily_reset_at: new Date(now.setUTCHours(24, 0, 0, 0)).toISOString(),
            })
            .eq('user_id', userId);
        } else {
          await supabaseClient
            .from('user_usage_stats')
            .update({
              uploads_today: (current.uploads_today || 0) + 1,
            })
            .eq('user_id', userId);
        }
      }
    } else {
      console.log(`✅ User ${userId} upload count incremented via RPC`);
    }
  } catch (error) {
    console.error('Error in incrementUserUsage:', error);
  }
}

/**
 * Generate a simple hash for file content
 */
function generateFileHash(fileData: string): string {
  // Simple hash function - in production, consider using crypto.subtle.digest
  let hash = 0;
  for (let i = 0; i < fileData.length; i++) {
    const char = fileData.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check if MCQs are cached for this file
 */
function getCachedMCQs(fileHash: string): any[] | null {
  const cached = mcqCache.get(fileHash);
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    console.log(`📦 Cache hit for file hash: ${fileHash}`);
    return cached.mcqs;
  }
  
  // Remove expired cache entry
  if (cached) {
    mcqCache.delete(fileHash);
  }
  
  return null;
}

/**
 * Cache MCQs for future use
 */
function cacheMCQs(fileHash: string, mcqs: any[]): void {
  mcqCache.set(fileHash, {
    mcqs: mcqs,
    timestamp: Date.now()
  });
  
  // Clean up old cache entries periodically
  if (mcqCache.size > 1000) { // Limit cache size
    const now = Date.now();
    for (const [key, value] of mcqCache.entries()) {
      if (now - value.timestamp > CACHE_DURATION) {
        mcqCache.delete(key);
      }
    }
  }
}

/**
 * Call Gemini API with text content (no file upload required)
 */
async function callGeminiWithText(textContent: string, prompt: string, maxRetries = 3) {
  // Build request body for text-only input
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt + "\n\nSTUDY MATERIAL:\n" + textContent },
        ],
      },
    ],
  };

  // Retry logic for temporary failures
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" +
          GEMINI_API_KEY,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        
        // Check if it's a temporary error (5xx) and we have retries left
        if (res.status >= 500 && attempt < maxRetries) {
          console.log(`Attempt ${attempt} failed with ${res.status}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          continue;
        }
        
        throw new Error(`Gemini API failed: ${errorText}`);
      }

      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      console.log(`Attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/**
 * Call Gemini API with file data directly (no storage required)
 */
async function callGeminiWithFileData(fileData: string, mimeType: string, prompt: string, maxRetries = 3) {
  // Check file size (Gemini has a 20MB limit)
  const fileSizeBytes = (fileData.length * 3) / 4; // base64 to actual size
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  
  if (fileSizeMB > 20) {
    throw new Error(`File too large: ${fileSizeMB.toFixed(1)}MB. Maximum size is 20MB. Please compress the file.`);
  }

  // Build request body
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: fileData, // base64 encoded file data
            },
          },
        ],
      },
    ],
  };

  // Retry logic for temporary failures
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" +
          GEMINI_API_KEY,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        
        // Check if it's a temporary error (5xx) and we have retries left
        if (res.status >= 500 && attempt < maxRetries) {
          console.log(`Attempt ${attempt} failed with ${res.status}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          continue;
        }
        
        throw new Error(`Gemini API failed: ${errorText}`);
      }

      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
      
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      console.log(`Attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
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

    // 1. Check global usage limit first
    const globalUsage = checkGlobalUsage();
    if (!globalUsage.allowed) {
      const resetTimeDays = Math.ceil((globalUsage.resetTime - Date.now()) / (24 * 60 * 60 * 1000));
      return new Response(
        JSON.stringify({ 
          ok: false, 
          error: `Service temporarily unavailable. Monthly limit reached. Resets in ${resetTimeDays} days.`,
          global_usage: {
            remaining: 0,
            reset_time: globalUsage.resetTime
          }
        }),
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Verify Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Missing or invalid token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Extract and verify user from token
    const token = authHeader.replace('Bearer ', '');
    
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

    // Verify user from token
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
      console.error("❌ Auth error:", authError);
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Invalid token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    
    console.log("✅ User authenticated:", user.id);

    // 4. Get user subscription and check limits
    const subscription = await getUserSubscription(user.id, supabaseClient);
    console.log(`👤 User ${user.id} subscription: ${subscription}`);
    
    const userLimits = await checkUserLimits(user.id, subscription, supabaseClient);
    if (!userLimits.allowed) {
      const resetTimeHours = Math.ceil((userLimits.resetTime - Date.now()) / (60 * 60 * 1000));
      const resetTimeDays = Math.ceil((userLimits.resetTime - Date.now()) / (24 * 60 * 60 * 1000));
      
      // Daily limit only (monthly limit removed)
      const errorMessage = `Daily limit reached. You can generate MCQs again in ${resetTimeDays} days.`;
      
      return new Response(
        JSON.stringify({ 
          ok: false, 
          error: errorMessage,
          user_limits: {
            subscription: subscription,
            limit_type: userLimits.limitType,
            remaining: 0,
            reset_time: userLimits.resetTime
          }
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Parse request body
    const { file_data, mime_type, text_content, content_type }: Body = await req.json();
    
    // Check if either file_data or text_content is provided
    if (!file_data && !text_content) {
      return new Response(
        JSON.stringify({ ok: false, error: "Either file_data or text_content is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // If file_data is provided, mime_type is required
    if (file_data && !mime_type) {
      return new Response(
        JSON.stringify({ ok: false, error: "mime_type is required when file_data is provided" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    console.log("📄 Content received, type:", content_type || mime_type);

    // 6. Generate content hash for caching
    const contentHash = generateFileHash(text_content || file_data!);
    console.log("🔑 Content hash:", contentHash);

    // 7. Check cache first
    const cachedMCQs = getCachedMCQs(contentHash);
    if (cachedMCQs) {
      console.log(`✅ Returning cached MCQs for hash: ${contentHash}`);
      return new Response(
        JSON.stringify({ 
          ok: true, 
          mcqs: cachedMCQs,
          generated_at: new Date().toISOString(),
          count: cachedMCQs.length,
          cached: true,
          user_limits: {
            subscription: subscription,
            remaining: userLimits.remaining,
            reset_time: userLimits.resetTime
          },
          global_usage: {
            remaining: globalUsage.remaining,
            reset_time: globalUsage.resetTime
          }
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 8. Generate new MCQs if not cached
    console.log("🤖 Generating new MCQs...");
    
    const prompt = `
You are an expert MCQ generator. Create 20 high-quality multiple-choice questions that test users' understanding and knowledge of the concepts, facts, and ideas covered in the study material.

CRITICAL REQUIREMENTS:
1. Questions MUST test understanding and knowledge of concepts, facts, and ideas - NOT retrieval of specific text passages
2. Questions must be answerable from MEMORY and COMPREHENSION - users should NOT need to look back at the material
3. NEVER use words like "text", "document", "passage", "material", "according to", "mentioned", "stated", "explained", "notes", or "discusses" in the question itself
4. Focus on testing KNOWLEDGE and UNDERSTANDING of the subject matter, not memory of specific wording
5. Each question must have exactly 4 options
6. Include "answer_index" (0-based index) for the correct answer
7. Respond ONLY with a valid JSON array - no markdown, no code blocks, no additional text

QUESTION TYPES TO INCLUDE:
- Factual knowledge questions (definitions, key facts, numbers, measurements)
- Conceptual understanding questions (processes, relationships, cause and effect)
- Application questions (using knowledge to solve problems or make predictions)
- Analysis questions (comparing, contrasting, identifying patterns)
- Questions about concepts, theories, formulas, or principles
- Questions about historical events, people, dates, or facts
- Questions about scientific processes, chemical reactions, or biological processes
- Questions about mathematical concepts, equations, or calculations

QUESTION TYPES TO STRICTLY AVOID:
- ANY questions that reference "text", "document", "passage", "material", "according to", "mentioned", "stated", "explained", "notes", "discusses"
- Questions asking "what does the image/figure/chart show" or "what is depicted in the image"
- Questions about document layout, structure, or organization
- Questions asking "where to find information" or "which page/section"
- Questions about study tips, learning strategies, or methodology
- Questions not directly covered in the provided material
- Questions requiring visual inspection of the material
- Questions about colors, shapes, or visual characteristics
- Questions asking users to identify something "in the picture" or "shown in the image"

GOOD EXAMPLES:
{ "question": "What is the resolving power of a light microscope?", "options": ["0.2 nm", "200 nm", "2 μm", "0.2 μm"], "answer_index": 1 }
{ "question": "Which process occurs during photosynthesis?", "options": ["Glucose breakdown", "Carbon dioxide absorption", "Protein synthesis", "DNA replication"], "answer_index": 1 }
{ "question": "What is the chemical formula for water?", "options": ["H2O", "CO2", "NaCl", "O2"], "answer_index": 0 }
{ "question": "Who was the first African American to serve in the U.S. Senate?", "options": ["Frederick Douglass", "Hiram Revels", "Booker T. Washington", "W.E.B. Du Bois"], "answer_index": 1 }
{ "question": "What type of sound sources exist besides musical instruments and traffic?", "options": ["Electronic devices", "Natural phenomena", "Human voices", "Animal sounds"], "answer_index": 1 }
{ "question": "How does the speed of sound change with temperature?", "options": ["Increases by 0.6 m/s per °C", "Decreases by 0.6 m/s per °C", "Remains constant", "Increases by 3.31 m/s per °C"], "answer_index": 0 }

BAD EXAMPLES (DO NOT CREATE THESE):
{ "question": "The text notes that sound waves are created by vibrations", "options": ["True", "False", "Sometimes", "Never"], "answer_index": 0 }
{ "question": "According to the text, what is the speed of sound?", "options": ["343 m/s", "300 m/s", "400 m/s", "250 m/s"], "answer_index": 0 }
{ "question": "What does the text explain about temperature?", "options": ["It affects sound speed", "It doesn't matter", "It's constant", "It varies"], "answer_index": 0 }
{ "question": "The passage mentions that...", "options": ["Option A", "Option B", "Option C", "Option D"], "answer_index": 0 }

IMPORTANT: Generate questions that test users' understanding and knowledge of the subject matter. Focus on concepts, facts, and ideas that users should know and understand, not on specific wording or references to the source material. Users should be able to answer all questions based on their knowledge and comprehension of the topics covered.
`;

    let geminiRaw: string;
    
    // If text_content is provided, use text-based API
    if (text_content) {
      geminiRaw = await callGeminiWithText(text_content, prompt);
    } else {
      // Otherwise, use file-based API
      geminiRaw = await callGeminiWithFileData(file_data!, mime_type!, prompt);
    }

    // Parse MCQs - handle both JSON and markdown formats
    let mcqs: any[] = [];
    try {
      // First try to parse as direct JSON
      mcqs = JSON.parse(geminiRaw);
    } catch {
      try {
        // If that fails, try to extract JSON from markdown format
        const jsonMatch = geminiRaw.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
          mcqs = JSON.parse(jsonMatch[1].trim());
        } else {
          // Try to find JSON array pattern without markdown
          const arrayMatch = geminiRaw.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (arrayMatch && arrayMatch[0]) {
            mcqs = JSON.parse(arrayMatch[0]);
          } else {
            throw new Error("Could not extract JSON from response");
          }
        }
      } catch (parseError) {
        throw new Error("Gemini did not return valid JSON. Raw response: " + geminiRaw);
      }
    }

    if (!Array.isArray(mcqs)) {
      throw new Error("Gemini response is not an array: " + geminiRaw);
    }

    console.log(`✅ Generated ${mcqs.length} MCQs successfully`);

    // 9. Increment usage counters
    incrementGlobalUsage();
    await incrementUserUsage(user.id, supabaseClient);

    // 10. Cache the MCQs for future use
    cacheMCQs(contentHash, mcqs);

    // Return MCQs directly (no database storage)
    return new Response(
      JSON.stringify({ 
        ok: true, 
        mcqs: mcqs,
        generated_at: new Date().toISOString(),
        count: mcqs.length,
        cached: false,
        user_limits: {
          subscription: subscription,
          remaining: userLimits.remaining - 1,
          reset_time: userLimits.resetTime
        },
        global_usage: {
          remaining: globalUsage.remaining - 1,
          reset_time: globalUsage.resetTime
        }
      }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (e) {
    console.error("Edge function error:", e);
    console.error("Error stack:", e.stack);
    console.error("Error message:", e.message);
    
    // Hide detailed errors in production for security
    const isDevelopment = Deno.env.get("ENVIRONMENT") === "development";
    
    let userMessage = "An unexpected error occurred. Please try again later.";
    
    // Show detailed errors only in development
    if (isDevelopment) {
        userMessage = e.message || String(e);
    } else {
        // Provide user-friendly messages for common errors in production
        if (e.message?.includes('File too large')) {
            userMessage = "File size exceeds the maximum allowed limit (20MB).";
        } else if (e.message?.includes('Gemini API')) {
            userMessage = "AI service is temporarily unavailable. Please try again later.";
        } else if (e.message?.includes('not authenticated')) {
            userMessage = "Authentication failed. Please log in again.";
        } else if (e.message?.includes('Failed to fetch')) {
            userMessage = "Network error. Please check your connection and try again.";
        } else if (e.message?.includes('JSON')) {
            userMessage = "Failed to process AI response. Please try again.";
        }
    }
    
    return new Response(
      JSON.stringify({ ok: false, error: userMessage }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});