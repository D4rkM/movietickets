// Requires a local part, @, and a domain with at least one dot + TLD
// (rejects "user@localhost"-style values with no real domain).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}
