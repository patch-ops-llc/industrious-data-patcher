-- The admin page password, once it has been changed on the page.
--
-- No row: the password is the ADMIN_PASSWORD service variable.
-- A row: the password is the one behind password_hash, and ADMIN_PASSWORD no
-- longer signs in. variable_hash remembers which ADMIN_PASSWORD value was in
-- place when the password was changed, so that giving the variable a new
-- value can be recognised: the service then removes the row and the variable
-- is the password again (the recovery path for a forgotten password).

CREATE TABLE admin_password (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT        NOT NULL,
  variable_hash TEXT        NOT NULL,
  changed_at    TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE admin_password IS 'The admin page password after it was changed on the page. Both columns are salted scrypt hashes; no password is stored. Deleting the row makes the ADMIN_PASSWORD service variable the password again.';
COMMENT ON COLUMN admin_password.password_hash IS 'Salted scrypt hash of the password set on the admin page.';
COMMENT ON COLUMN admin_password.variable_hash IS 'Salted scrypt hash of the ADMIN_PASSWORD value in place when the password was changed. When the variable no longer matches it, the row is removed.';
