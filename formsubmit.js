async function sendNotification(lead, recipient, origin, fetcher = fetch) {
  const response = await fetcher(
    `https://formsubmit.co/ajax/${encodeURIComponent(recipient)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        _subject: `Pinterok: new ${lead.type === "appointments" ? "appointment request" : "enquiry"}`,
        _template: "table",
        _captcha: "false",
        _url: origin,
        _replyto: lead.email,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        brand: lead.brand,
        postcode: lead.postcode || "Not supplied",
        preferredDate: lead.preferredDate || "Not specified",
        message: lead.problem,
        requestId: String(lead._id),
      }),
    },
  );
  if (!response.ok) throw new Error("FormSubmit request failed.");
  const result = await response.json();
  if (result.success !== true && result.success !== "true") {
    throw new Error("FormSubmit did not accept the notification.");
  }
}

module.exports = { sendNotification };
