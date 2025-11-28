-- Update check_upload_limit function to check daily limit instead of monthly limit
CREATE OR REPLACE FUNCTION check_upload_limit()
RETURNS TRIGGER AS $$
DECLARE
    user_plan TEXT;
    current_uploads INTEGER;
    upload_limit INTEGER;
BEGIN
    -- ユーザーのプランを取得
    SELECT plan_type INTO user_plan
    FROM user_subscriptions
    WHERE user_id = NEW.user_id;
    
    -- プランが存在しない場合はfreeプランとして扱う
    IF user_plan IS NULL THEN
        user_plan := 'free';
    END IF;
    
    -- 今日のアップロード数を取得（日次制限に変更）
    SELECT uploads_today INTO current_uploads
    FROM user_usage_stats
    WHERE user_id = NEW.user_id;
    
    -- アップロード数が存在しない場合は0として扱う
    IF current_uploads IS NULL THEN
        current_uploads := 0;
    END IF;
    
    -- プランに応じた日次制限を設定
    IF user_plan = 'free' THEN
        upload_limit := 5;  -- Freeプラン: 5ファイル/日
    ELSIF user_plan = 'pro' THEN
        upload_limit := 50; -- Proプラン: 50ファイル/日
    ELSE
        upload_limit := 5;  -- デフォルトはFreeプラン
    END IF;
    
    -- 制限チェック
    IF current_uploads >= upload_limit THEN
        RAISE EXCEPTION 'Daily upload limit exceeded for % plan. Current uploads today: %, Daily limit: %', 
            user_plan, current_uploads, upload_limit;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

