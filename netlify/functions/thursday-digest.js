// The Thursday email (candle requests for the coming week and Repository orders for the coming weekend), sent to the parish office.
// Netlify runs this on a schedule (see netlify.toml): three times on Thursday mornings, so a failed attempt is tried again an hour later. Each run
// only sends if the parish's own time is Thursday, 8 o'clock or later, the email is switched on, and this week's has not already gone.
// Scheduled functions run only on the published site, never on a preview.
const api = require('./api.js');

exports.handler = async () => {
  try {
    const results = await api.runWeeklyDigests(new Date());
    console.log('thursday-digest', JSON.stringify(results));
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (e) {
    console.error('thursday-digest failed', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
