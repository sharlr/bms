-- Dutch (Nederlands) joins English and French as a user language.
ALTER TABLE users DROP CONSTRAINT users_language_check;
ALTER TABLE users ADD CONSTRAINT users_language_check CHECK (language IN ('en','fr','nl'));
