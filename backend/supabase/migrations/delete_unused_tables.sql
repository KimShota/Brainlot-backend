-- Delete unused tables: mcqs, files, and jobs
-- These tables are not used in the current system
-- MCQs are returned directly from Edge Function without database storage

-- 1. Drop triggers that depend on files table first
DROP TRIGGER IF EXISTS update_usage_stats_trigger ON files;

-- 2. Drop functions that might depend on these tables
DROP FUNCTION IF EXISTS update_usage_stats() CASCADE;

-- 3. Drop dependent tables first (tables that have foreign keys to files)
-- Drop mcqs table (depends on files)
DROP TABLE IF EXISTS mcqs CASCADE;

-- Drop jobs table (depends on files)
DROP TABLE IF EXISTS jobs CASCADE;

-- 4. Drop files table (depends on auth.users, but that's fine)
DROP TABLE IF EXISTS files CASCADE;

-- Note: CASCADE will automatically drop:
-- - Foreign key constraints
-- - Indexes
-- - Any other dependent objects

