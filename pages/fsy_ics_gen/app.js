class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = "TemplateError";
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseDate(value) {
  const trimmed = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new TemplateError(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));

  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new TemplateError(`Invalid calendar date "${value}".`);
  }

  return { year, month, day };
}

function isSunday(dateObj) {
  const d = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  return d.getUTCDay() === 0;
}

function addDays(dateObj, days) {
  const d = new Date(Date.UTC(dateObj.year, dateObj.month - 1, dateObj.day));
  d.setUTCDate(d.getUTCDate() + days);

  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function parseTime24(value) {
  const match = String(value).trim().match(/^(\d{2}):(\d{2})$/);

  if (!match) {
    throw new TemplateError(`Invalid precompiled time "${value}". Expected HH:MM.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new TemplateError(`Invalid precompiled time "${value}".`);
  }

  return { hour, minute };
}

function compareTimes(a, b) {
  return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute);
}

function validateTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new TemplateError(
      `Unknown timezone "${timezone}". Use an IANA timezone like America/Denver.`
    );
  }
}

function validateTemplate(template) {
  if (!Array.isArray(template)) {
    throw new TemplateError(
      "window.FSY_TEMPLATE was not found or is not an array. Make sure fsy_template.js loads before app.js."
    );
  }

  if (template.length === 0) {
    throw new TemplateError("window.FSY_TEMPLATE is empty.");
  }

  let eventCount = 0;

  for (const [dayIndex, day] of template.entries()) {
    if (!Number.isInteger(day.dayOffset)) {
      throw new TemplateError(`Day entry ${dayIndex + 1} is missing integer dayOffset.`);
    }

    if (!Array.isArray(day.events)) {
      throw new TemplateError(`Day entry ${dayIndex + 1} is missing events array.`);
    }

    for (const [eventIndex, event] of day.events.entries()) {
      const where = `${day.label || `Day ${day.dayOffset}`} event ${eventIndex + 1}`;

      if (!event.title) {
        throw new TemplateError(`${where} is missing title.`);
      }

      if (!event.start) {
        throw new TemplateError(`${where} "${event.title}" is missing start.`);
      }

      if (!event.end) {
        throw new TemplateError(`${where} "${event.title}" is missing end.`);
      }

      const start = parseTime24(event.start);
      const end = parseTime24(event.end);

      if (compareTimes(end, start) <= 0) {
        throw new TemplateError(
          `${where} "${event.title}" has end time less than or equal to start time. Overnight events are not supported.`
        );
      }

      eventCount += 1;
    }
  }

  if (eventCount === 0) {
    throw new TemplateError("window.FSY_TEMPLATE contains no events.");
  }

  return eventCount;
}

function formatICSDateTime(dateObj, timeObj) {
  return (
    String(dateObj.year) +
    pad2(dateObj.month) +
    pad2(dateObj.day) +
    "T" +
    pad2(timeObj.hour) +
    pad2(timeObj.minute) +
    "00"
  );
}

function formatUTCDateTime(date) {
  return (
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "T" +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z"
  );
}

function icsEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n");
}

function foldICSLine(line) {
  const encoder = new TextEncoder();

  if (encoder.encode(line).length <= 75) {
    return line;
  }

  const folded = [];
  let current = "";

  for (const char of line) {
    const candidate = current + char;

    if (encoder.encode(candidate).length > 75) {
      folded.push(current);
      current = " " + char;
    } else {
      current = candidate;
    }
  }

  if (current) {
    folded.push(current);
  }

  return folded.join("\r\n");
}

function randomUID() {
  if (crypto?.randomUUID) {
    return `${crypto.randomUUID()}@fsy-ics-generator`;
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}@fsy-ics-generator`;
}

function buildScheduleFromPrecompiledTemplate(startDate, timezone) {
  const start = parseDate(startDate);

  if (!isSunday(start)) {
    throw new TemplateError("Starting date must be a Sunday.");
  }

  const events = [];

  for (const day of window.FSY_TEMPLATE) {
    const eventDate = addDays(start, day.dayOffset);

    for (const event of day.events) {
      events.push({
        date: eventDate,
        timezone,
        title: event.title,
        startTime: parseTime24(event.start),
        endTime: parseTime24(event.end),
        description: event.description || "",
        location: event.location || "",
      });
    }
  }

  return { timezone, events };
}

function buildICS(schedule, calendarName) {
  const dtstamp = formatUTCDateTime(new Date());

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FSY ICS Generator//GitHub Pages//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calendarName || "FSY Calendar")}`,
    `X-WR-TIMEZONE:${schedule.timezone}`,
  ];

  for (const event of schedule.events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${randomUID()}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${icsEscape(event.title)}`);
    lines.push(
      `DTSTART;TZID=${schedule.timezone}:${formatICSDateTime(
        event.date,
        event.startTime
      )}`
    );
    lines.push(
      `DTEND;TZID=${schedule.timezone}:${formatICSDateTime(
        event.date,
        event.endTime
      )}`
    );

    if (event.description) {
      lines.push(`DESCRIPTION:${icsEscape(event.description)}`);
    }

    if (event.location) {
      lines.push(`LOCATION:${icsEscape(event.location)}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.map(foldICSLine).join("\r\n") + "\r\n";
}

function filenameFromStartDate(startDate) {
  const [year, month, day] = startDate.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const monthName = d
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toLowerCase();

  return `fsy_calendar_${monthName}_${pad2(day)}.ics`;
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  a.remove();
  URL.revokeObjectURL(url);
}

function setMessage(kind, text) {
  const el = document.getElementById("message");
  el.className = `message ${kind}`;
  el.textContent = text;
}

function clearMessage() {
  const el = document.getElementById("message");
  el.className = "message";
  el.textContent = "";
}

function formatDateForSelect(date) {
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate())
  );
}

function getCurrentOrNextSunday() {
  const today = new Date();

  // Sunday = 0, Monday = 1, ..., Saturday = 6
  const dayOfWeek = today.getDay();
  const daysUntilSunday = (7 - dayOfWeek) % 7;

  const sunday = new Date(today);
  sunday.setDate(today.getDate() + daysUntilSunday);

  return formatDateForSelect(sunday);
}

function setDefaultStartDateToCurrentOrNextSunday() {
  const select = document.getElementById("startDate");
  const targetSunday = getCurrentOrNextSunday();

  const availableDates = Array.from(select.options).map(option => option.value);

  if (availableDates.includes(targetSunday)) {
    select.value = targetSunday;
    return;
  }

  // If current/next Sunday is before the available range, choose the first
  // available Sunday. If it is after the range, choose the last.
  const futureDate = availableDates.find(date => date >= targetSunday);
  select.value = futureDate || availableDates[availableDates.length - 1];
}

setDefaultStartDateToCurrentOrNextSunday();

document.getElementById("generateButton").addEventListener("click", () => {
  try {
    clearMessage();

    const startDate = document.getElementById("startDate").value;
    const timezone = document.getElementById("timezone").value.trim();
    const calendarName =
      document.getElementById("calendarName").value.trim() || "FSY Calendar";

    if (!startDate) {
      throw new TemplateError("Choose a starting date.");
    }

    if (!timezone) {
      throw new TemplateError("Choose a timezone.");
    }

    validateTimezone(timezone);
    validateTemplate(window.FSY_TEMPLATE);

    const schedule = buildScheduleFromPrecompiledTemplate(startDate, timezone);
    const ics = buildICS(schedule, calendarName);
    const filename = filenameFromStartDate(startDate);

    downloadTextFile(filename, ics, "text/calendar;charset=utf-8");

    setMessage(
      "ok",
      `Generated: ${filename}\nStarting date: ${startDate}\nTimezone: ${schedule.timezone}`
    );
  } catch (error) {
    if (error instanceof TemplateError) {
      setMessage("error", error.message);
    } else {
      console.error(error);
      setMessage("error", `Unexpected error: ${error.message || error}`);
    }
  }
});