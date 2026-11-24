-- Each user's GitHub token, sealed with the server's token key. NULL when the user saved none.
ALTER TABLE users ADD COLUMN github_token BLOB;
