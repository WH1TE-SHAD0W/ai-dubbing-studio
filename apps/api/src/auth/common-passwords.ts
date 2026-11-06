// A short list of very common passwords that are refused for new accounts
// (ADR-0003). Better Auth only checks the length, so this check is ours. Only
// entries of 12 characters or more are listed: shorter ones already fail the
// length rule. Compared ignoring case and surrounding spaces.
const COMMON_PASSWORDS = new Set([
  "000000000000",
  "111111111111",
  "123123123123",
  "123456123456",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789123",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "aaaaaaaaaaaa",
  "abc123abc123",
  "abcdefghijkl",
  "asdfasdfasdf",
  "asdfghjkl123",
  "administrator",
  "baseball1234",
  "correcthorsebatterystaple",
  "correct horse battery staple",
  "football1234",
  "iloveyou1234",
  "letmein12345",
  "monkey123456",
  "p@ssw0rd1234",
  "passw0rd1234",
  "password1234",
  "password123!",
  "password12345",
  "passwordpassword",
  "princess1234",
  "qazwsxedcrfv",
  "qwerty123456",
  "qwertyqwerty",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwertyuiopasdf",
  "sunshine1234",
  "superman1234",
  "trustno1trustno1",
  "welcome12345",
  "zaq12wsxcde3",
  "zxcvbnm12345",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
