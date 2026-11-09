/** Strips every non-digit character from a CPF string. */
export function cleanCpf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Validates a Brazilian CPF number (formatted or digits-only) by checking its
 * 11-digit length, rejecting repeated-digit sequences, and verifying both
 * modulo-11 check digits.
 */
export function isValidCpf(value: string): boolean {
  const digits = cleanCpf(value);
  if (digits.length !== 11) {
    return false;
  }

  // Reject sequences where all 11 digits are identical (e.g. 00000000000, 11111111111).
  if (/^(\d)\1{10}$/.test(digits)) {
    return false;
  }

  const calcDigit = (sliceLength: number): number => {
    let sum = 0;
    for (let i = 0; i < sliceLength; i++) {
      sum += Number(digits[i]) * (sliceLength + 1 - i);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const firstCheck = calcDigit(9);
  if (firstCheck !== Number(digits[9])) {
    return false;
  }

  const secondCheck = calcDigit(10);
  return secondCheck === Number(digits[10]);
}

/** Validates basic e-mail formatting before submitting a payment attempt. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
