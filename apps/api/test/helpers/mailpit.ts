const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://localhost:8025";
const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 300;

export interface MailpitMessage {
  Subject: string;
  To: { Address: string; Name: string }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls Mailpit's search API for a message mentioning the given term (e.g. a
 * booking ID) — sendMail is awaited before BookingService returns, so the
 * message is already queued by the time the HTTP response comes back, but a
 * short poll absorbs Mailpit's own indexing delay.
 */
export async function findMailpitMessage(searchTerm: string): Promise<MailpitMessage> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(searchTerm)}`);
    const body = await response.json();
    if (body.messages?.length > 0) {
      return body.messages[0];
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`No Mailpit message found matching "${searchTerm}" after ${POLL_ATTEMPTS} attempts`);
}
