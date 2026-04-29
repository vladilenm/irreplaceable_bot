// Vitest setup — minimal env vars set BEFORE config.ts module loads.
// requireEnv / requireEnvInt fail-fast at import-time on missing values.
process.env['BOT_TOKEN'] ??= 'test-token';
process.env['TARGET_CHAT_ID'] ??= '-1001';
process.env['AI_RADAR_THREAD_ID'] ??= '1';
process.env['AI_API_KEY'] ??= 'test-key';
process.env['AI_MODEL'] ??= 'claude-sonnet-4-20250514';
process.env['THREAD_SUMMARY_THREAD_ID'] ??= '2';
process.env['DB_PATH'] ??= ':memory:';
