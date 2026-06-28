import express from 'express';
import axios from 'axios';

const app = express();

// SINK: ships data to a third-party analytics service over HTTP.
async function sendToAnalytics(payload: Record<string, unknown>): Promise<void> {
  await axios.post('https://analytics.example.com/track', payload);
}

// CROSS-FUNCTION HOP: shapes the outbound event from a raw email.
function buildTrackingEvent(email: string): Record<string, unknown> {
  return { event: 'signup', userEmail: email };
}

// Carries the PII email from the handler to the event builder + external sink.
async function trackSignup(email: string): Promise<void> {
  const event = buildTrackingEvent(email);
  await sendToAnalytics(event);
}

// SOURCE: req.body.email is PII supplied by the user.
app.post('/signup', async (req, res) => {
  const email = req.body.email;
  await trackSignup(email);
  res.status(202).end();
});

app.listen(3000);
