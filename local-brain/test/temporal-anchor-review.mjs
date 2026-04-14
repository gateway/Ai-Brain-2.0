import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveTemporalClaimText,
  extractFocusedTemporalSnippet,
  inferRelativeTemporalAnswerLabel
} from "../dist/retrieval/service.js";

test("relative temporal labels prefer occurredAt over later reference time", () => {
  assert.equal(
    inferRelativeTemporalAnswerLabel(
      "Yeah, I painted that lake sunrise last year!",
      "2023-05-07T00:00:00.000Z",
      "2023-10-19T00:00:00.000Z"
    ),
    "2022"
  );
});

test("focused temporal snippet prefers the event-local festival sentence", () => {
  const content = [
    "Jon: Woah, that pic's from when my dance crew took home first in a local comp last year.",
    "Gina: Wow! Winning first place is amazing!",
    "Jon: Thanks! I rehearsed with a small group of dancers after work.",
    "Jon: Finishing up choreography to perform at a nearby festival next month. Can't wait!"
  ].join(" ");

  assert.equal(
    extractFocusedTemporalSnippet(content, "When is Jon's group performing at a festival?"),
    "Jon: Finishing up choreography to perform at a nearby festival next month."
  );
});

test("focused temporal snippet ignores multimodal sidecar text during source backfill", () => {
  const content = [
    "Jon: Wow, I'm excited too! This is gonna be great! [image: a photography of a man in a suit is performing a dance]",
    "--- image_query: dancing on stage performance dance competition last year",
    "--- image_caption: a photography of a man in a suit is performing a dance",
    "Jon: Thanks! I rehearsed with a small group of dancers after work. Finishing up choreography to perform at a nearby festival next month. Can't wait!"
  ].join("\n");

  assert.equal(
    extractFocusedTemporalSnippet(content.replace(/\n/g, " "), "When is Jon's group performing at a festival?"),
    "Finishing up choreography to perform at a nearby festival next month."
  );
});

test("temporal claim derivation prefers provenance-linked event-local relative cues", () => {
  const claimText = deriveTemporalClaimText("When is Jon's group performing at a festival?", [
    {
      memoryId: "topic-segment",
      memoryType: "artifact_derivation",
      content: "Topic segment about dance and performance.",
      score: 1,
      artifactId: "artifact-1",
      occurredAt: "2023-01-20T16:04:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        tier: "artifact_derivation",
        metadata: {
          source_turn_text: "Thanks! I rehearsed with a small group of dancers after work. Finishing up choreography to perform at a nearby festival next month. Can't wait!"
        }
      }
    },
    {
      memoryId: "wrong-neighbor",
      memoryType: "episodic_memory",
      content: "Looks like you all had fun yesterday.",
      score: 0.5,
      artifactId: "artifact-2",
      occurredAt: "2023-10-19T00:00:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        tier: "focused_episodic_support",
        metadata: {
          source_turn_text: "Looks like you all had fun yesterday.",
          is_relative_time: true,
          time_granularity: "day"
        }
      }
    }
  ]);

  assert.equal(claimText, "The best supported month is February 2023.");
});

test("temporal claim derivation resolves first-watch relative cues against the benchmark anchor", () => {
  const claimText = deriveTemporalClaimText('When did Joanna first watch "Eternal Sunshine of the Spotless Mind"?', [
    {
      memoryId: "temporal-media-anchor",
      memoryType: "procedural_memory",
      content:
        "Joanna watched Eternal Sunshine of the Spotless Mind. Time hint: around 3 years ago. Normalized year: 2019. Context: I first watched it around 3 years ago.",
      score: 1,
      artifactId: "artifact-joanna-movie",
      occurredAt: "2022-01-21T19:31:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        typed_fact_kind: "temporal_media_anchor",
        subject_name: "Joanna",
        media_title: "Eternal Sunshine of the Spotless Mind",
        mention_kind: "watched",
        time_hint_text: "around 3 years ago",
        normalized_year: "2019",
        event_anchor_start: "2022-01-21T19:31:00.000Z",
        event_anchor_end: "2022-01-21T19:31:00.000Z"
      }
    }
  ]);

  assert.equal(claimText, "The best supported year is 2019.");
});

test("temporal claim derivation trims malformed trailing punctuation from quoted first-watch titles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-title-"));
  const sourcePath = path.join(dir, "source.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-01-21T19:31:00.000Z",
      "",
      "Joanna: Eternal Sunshine of the Spotless Mind is one of my favorites.",
      "Joanna: I first watched it around 3 years ago."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText('When did Joanna first watch "Eternal Sunshine of the Spotless Mind?', [
      {
        memoryId: "temporal-media-source",
        memoryType: "episodic_memory",
        content: "Joanna: Eternal Sunshine of the Spotless Mind is one of my favorites.",
        score: 1,
        artifactId: "artifact-joanna-movie-source",
        occurredAt: "2022-01-21T19:31:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Joanna: I first watched it around 3 years ago."
          }
        }
      }
    ]);

    assert.equal(claimText, "The best supported year is 2019.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation prefers creation-event relative cues for paintings", () => {
  const claimText = deriveTemporalClaimText("When did Melanie paint a sunrise?", [
    {
      memoryId: "melanie-sunrise",
      memoryType: "episodic_memory",
      content: "Melanie: Yeah, I painted that lake sunrise last year! It's special to me.",
      score: 1,
      artifactId: "artifact-sunrise",
      occurredAt: "2023-05-08T13:56:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        source_uri: "/tmp/conv-26-session_1.md",
        metadata: {
          source_sentence_text: "Melanie: Yeah, I painted that lake sunrise last year! It's special to me."
        }
      }
    }
  ]);

  assert.equal(claimText, "The best supported year is 2022.");
});

test("temporal claim derivation prefers occurredAt for resolved relative day evidence", () => {
  const claimText = deriveTemporalClaimText("When did Caroline go to the LGBTQ support group?", [
    {
      memoryId: "caroline-support-group",
      memoryType: "episodic_memory",
      content: "What's up with you? Anything new? Caroline: I went to a LGBTQ support group yesterday and it was so powerful.",
      score: 1,
      artifactId: "artifact-support-group",
      occurredAt: "2023-05-07T00:00:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        source_uri: "/tmp/conv-26-session_1.md",
        metadata: {
          is_relative_time: true,
          time_granularity: "day",
          source_sentence_text:
            "What's up with you? Anything new? Caroline: I went to a LGBTQ support group yesterday and it was so powerful."
        }
      }
    }
  ]);

  assert.equal(claimText, "The best supported date is 7 May 2023.");
});

test("relative temporal labels resolve last week and week-before phrasing against the event anchor", () => {
  assert.equal(
    inferRelativeTemporalAnswerLabel(
      "Nate: I won my first video game tournament last week - so exciting!",
      "2022-01-21T19:31:00.000Z",
      "2022-01-21T19:31:00.000Z"
    ),
    "14 January 2022"
  );
  assert.equal(
    inferRelativeTemporalAnswerLabel(
      "It happened the week before the tournament check-in.",
      "2022-01-21T19:31:00.000Z",
      "2022-01-21T19:31:00.000Z"
    ),
    "14 January 2022"
  );
});

test("temporal claim derivation prefers anchored relative wording for school-event last week phrasing", () => {
  const claimText = deriveTemporalClaimText("When did Caroline give a speech at a school?", [
    {
      memoryId: "caroline-school-speech",
      memoryType: "episodic_memory",
      content:
        "Caroline: I wanted to tell you about my school event last week. It was awesome! I talked about my transgender journey.",
      score: 1,
      artifactId: "artifact-school-event",
      occurredAt: "2023-06-09T19:55:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        source_uri: "/tmp/conv-26-session_3.md",
        metadata: {
          source_sentence_text:
            "Caroline: I wanted to tell you about my school event last week. It was awesome! I talked about my transgender journey."
        }
      }
    }
  ]);

  assert.equal(claimText, "the week before June 9, 2023.");
});

test("temporal claim derivation prefers anchored relative wording for charity-race weekend phrasing", () => {
  const claimText = deriveTemporalClaimText("When did Melanie run a charity race?", [
    {
      memoryId: "mel-charity-race",
      memoryType: "episodic_memory",
      content:
        "Melanie: I ran a charity race for mental health last Saturday - it was really rewarding.",
      score: 1,
      artifactId: "artifact-charity-race",
      occurredAt: "2023-05-25T13:14:00.000Z",
      namespaceId: "ns_temporal_anchor",
      provenance: {
        source_uri: "/tmp/conv-26-session_2.md",
        metadata: {
          source_sentence_text:
            "Melanie: I ran a charity race for mental health last Saturday - it was really rewarding."
        }
      }
    }
  ]);

  assert.equal(claimText, "the sunday before May 25, 2023.");
});

test("temporal claim derivation prefers anchored range wording for first travel queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-travel-"));
  const earlierSourcePath = path.join(dir, "conv-50-session_2.md");
  const laterSourcePath = path.join(dir, "conv-50-session_3.md");
  writeFileSync(
    earlierSourcePath,
    [
      "Captured: 2023-03-26T00:00:00.000Z",
      "",
      "Calvin: I wish I could do something more interesting than just work at the book store!",
      "Dave: If I had money I'd go to Tokyo"
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    laterSourcePath,
    [
      "Captured: 2023-04-20T00:00:00.000Z",
      "",
      "Calvin: I just went to Tokyo for a game festival and had a blast."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Calvin first travel to Tokyo?", [
      {
        memoryId: "tokyo-earlier",
        memoryType: "episodic_memory",
        content: "Dave: If I had money I'd go to Tokyo",
        score: 0.7,
        artifactId: "artifact-early-tokyo",
        occurredAt: "2023-03-26T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: earlierSourcePath,
          metadata: {
            source_sentence_text: "Dave: If I had money I'd go to Tokyo"
          }
        }
      },
      {
        memoryId: "tokyo-later",
        memoryType: "episodic_memory",
        content: "Calvin: I just went to Tokyo for a game festival and had a blast.",
        score: 1,
        artifactId: "artifact-late-tokyo",
        occurredAt: "2023-04-20T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: laterSourcePath,
          metadata: {
            source_sentence_text: "Calvin: I just went to Tokyo for a game festival and had a blast."
          }
        }
      }
    ]);

    assert.equal(claimText, "between 26 March 2023 and 20 April 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation prefers anchored weekend wording for saw-live queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-live-"));
  const sourcePath = path.join(dir, "conv-50-session_2.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-03-26T00:00:00.000Z",
      "",
      "Dave: I saw Aerosmith perform live last weekend and they were incredible."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Dave see Aerosmith perform live?", [
      {
        memoryId: "aerosmith-live",
        memoryType: "episodic_memory",
        content: "Dave: I saw Aerosmith perform live last weekend and they were incredible.",
        score: 1,
        artifactId: "artifact-aerosmith-live",
        occurredAt: "2023-03-26T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Dave: I saw Aerosmith perform live last weekend and they were incredible."
          }
        }
      }
    ]);

    assert.equal(claimText, "the weekend before March 26, 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-event temporal derivation prefers the earliest anchored tournament evidence across sessions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-first-event-"));
  const firstPath = path.join(dir, "conv-42-session_1.md");
  const laterPath = path.join(dir, "conv-42-session_19.md");
  writeFileSync(
    firstPath,
    [
      "Captured: 2022-01-21T19:31:00.000Z",
      "",
      "Nate: I won my first video game tournament last week - so exciting!"
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    laterPath,
    [
      "Captured: 2022-10-05T09:00:00.000Z",
      "",
      "Nate: I won an international tournament yesterday! It was wild."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Nate win his first video game tournament?", [
      {
        memoryId: "nate-first",
        memoryType: "episodic_memory",
        content: "Nate: I won my first video game tournament last week - so exciting!",
        score: 1,
        artifactId: "artifact-first",
        occurredAt: "2022-01-21T19:31:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: firstPath,
          metadata: {
            source_sentence_text: "Nate: I won my first video game tournament last week - so exciting!"
          }
        }
      },
      {
        memoryId: "nate-later",
        memoryType: "episodic_memory",
        content: "Nate: I won an international tournament yesterday! It was wild.",
        score: 1,
        artifactId: "artifact-later",
        occurredAt: "2022-10-05T09:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: laterPath,
          metadata: {
            source_sentence_text: "Nate: I won an international tournament yesterday! It was wild."
          }
        }
      }
    ]);

    assert.equal(claimText, "the week before January 21, 2022.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation preserves next-month anchored phrasing for Seattle game timing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-seattle-"));
  const sourcePath = path.join(dir, "conv-43-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-16T16:21:00.000Z",
      "",
      "John: It's Seattle, I'm stoked for my game there next month!"
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When was John in Seattle for a game?", [
      {
        memoryId: "john-seattle",
        memoryType: "episodic_memory",
        content: "John: It's Seattle, I'm stoked for my game there next month!",
        score: 1,
        artifactId: "artifact-john-seattle",
        occurredAt: "2023-07-16T16:21:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "John: It's Seattle, I'm stoked for my game there next month!"
          }
        }
      }
    ]);

    assert.equal(claimText, "early August, 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation preserves anchored week phrasing for new-job start queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-job-"));
  const sourcePath = path.join(dir, "conv-44-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-03-27T16:19:00.000Z",
      "",
      "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Andrew start his new job as a financial analyst?", [
      {
        memoryId: "andrew-job",
        memoryType: "episodic_memory",
        content: "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change.",
        score: 1,
        artifactId: "artifact-andrew-job",
        occurredAt: "2023-03-27T16:19:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Andrew: I started a new job as a Financial Analyst last week - it's been quite a change."
          }
        }
      }
    ]);

    assert.equal(claimText, "the week before March 27, 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation infers adoption year from duration-held phrasing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-dogs-"));
  const sourcePath = path.join(dir, "conv-44-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-03-27T13:10:00.000Z",
      "",
      "Conversation between Audrey and Andrew",
      "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("Which year did Audrey adopt the first three of her dogs?", [
      {
        memoryId: "audrey-dogs",
        memoryType: "episodic_memory",
        content: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda.",
        score: 1,
        artifactId: "artifact-audrey-dogs",
        occurredAt: "2023-03-27T13:10:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Audrey: I've had them for 3 years! Their names are Pepper, Precious and Panda."
          }
        }
      }
    ]);

    assert.equal(claimText, "2020.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation keeps career-high month anchored to the previous month window", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-career-high-"));
  const sourcePath = path.join(dir, "conv-43-session_3.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-16T16:21:00.000Z",
      "",
      "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("In which month's game did John achieve a career-high score in points?", [
      {
        memoryId: "john-career-high",
        memoryType: "episodic_memory",
        content: "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever.",
        score: 1,
        artifactId: "artifact-john-career-high",
        occurredAt: "2023-07-16T16:21:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text:
              "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever."
          }
        }
      }
    ]);

    assert.equal(claimText, "June 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation ignores non-points and generic game rows for career-high points queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-career-high-neighborhood-"));
  const careerHighPath = path.join(dir, "conv-43-session_3.md");
  const genericGamePath = path.join(dir, "conv-43-session_5.md");
  const assistsPath = path.join(dir, "conv-43-session_23.md");
  writeFileSync(
    careerHighPath,
    [
      "Captured: 2023-07-16T16:21:00.000Z",
      "",
      "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever."
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    genericGamePath,
    [
      "Captured: 2023-08-09T10:29:00.000Z",
      "",
      "John: Last week I had a crazy game - crazy intense! We won it by a tight score."
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    assistsPath,
    [
      "Captured: 2023-12-11T20:28:00.000Z",
      "",
      "John: I had a career-high in assists last Friday in our big game against our rival."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("In which month's game did John achieve a career-high score in points?", [
      {
        memoryId: "john-career-high",
        memoryType: "episodic_memory",
        content: "John: So much has happened in the last month - on and off the court. Last week I scored 40 points, my highest ever.",
        score: 1,
        artifactId: "artifact-john-career-high",
        occurredAt: "2023-07-16T16:21:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: { source_uri: careerHighPath, metadata: {} }
      },
      {
        memoryId: "john-generic-game",
        memoryType: "episodic_memory",
        content: "John: Last week I had a crazy game - crazy intense! We won it by a tight score.",
        score: 1.2,
        artifactId: "artifact-john-generic-game",
        occurredAt: "2023-08-09T10:29:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: { source_uri: genericGamePath, metadata: {} }
      },
      {
        memoryId: "john-assists-career-high",
        memoryType: "episodic_memory",
        content: "John: I had a career-high in assists last Friday in our big game against our rival.",
        score: 1.1,
        artifactId: "artifact-john-assists",
        occurredAt: "2023-12-11T20:28:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: { source_uri: assistsPath, metadata: {} }
      }
    ]);

    assert.equal(claimText, "June 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation prefers primary-speaker few-years-ago loss over neighboring last-year loss", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-loss-"));
  const sourcePath = path.join(dir, "conv-48-session_1.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-01-23T16:06:00.000Z",
      "",
      "Conversation between Deborah and Jolene",
      "Deborah: It was full of memories, she passed away a few years ago.",
      "Jolene: My mother also passed away last year."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Deborah`s mother pass away?", [
      {
        memoryId: "deborah-loss",
        memoryType: "episodic_memory",
        content: "Deborah: It was full of memories, she passed away a few years ago.",
        score: 1,
        artifactId: "artifact-deborah-loss",
        occurredAt: "2023-01-23T16:06:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Deborah: It was full of memories, she passed away a few years ago."
          }
        }
      }
    ]);

    assert.equal(claimText, "a few years before 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation infers resumed-drums month from one-month-playing backfill", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-drums-"));
  const earlierSourcePath = path.join(dir, "conv-47-session_3.md");
  const laterSourcePath = path.join(dir, "conv-47-session_24.md");
  writeFileSync(
    earlierSourcePath,
    [
      "Captured: 2022-03-27T00:40:00.000Z",
      "",
      "Conversation between James and John",
      "John: Thanks, James! I play drums too!",
      "John: I've been playing for a month now, it's been tough but fun."
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    laterSourcePath,
    [
      "Captured: 2022-09-18T18:02:00.000Z",
      "",
      "Conversation between James and John",
      "John: I used to play drums when I was younger, but haven't in a while."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did John resume playing drums in his adulthood?", [
      {
        memoryId: "john-drums-resumed",
        memoryType: "episodic_memory",
        content: "John: Thanks, James! I play drums too! John: I've been playing for a month now, it's been tough but fun.",
        score: 1,
        artifactId: "artifact-john-drums-resumed",
        occurredAt: "2022-03-27T00:40:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: earlierSourcePath,
          metadata: {
            source_sentence_text:
              "John: Thanks, James! I play drums too! John: I've been playing for a month now, it's been tough but fun."
          }
        }
      },
      {
        memoryId: "john-drums-hiatus",
        memoryType: "episodic_memory",
        content: "John: I used to play drums when I was younger, but haven't in a while.",
        score: 0.8,
        artifactId: "artifact-john-drums-hiatus",
        occurredAt: "2022-09-18T18:02:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: laterSourcePath,
          metadata: {
            source_sentence_text: "John: I used to play drums when I was younger, but haven't in a while."
          }
        }
      }
    ]);

    assert.equal(claimText, "February 2022.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation preserves weekday-before anchors for adoption-style queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-weekday-before-"));
  const sourcePath = path.join(dir, "conv-26-session_18.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-15T00:00:00.000Z",
      "",
      "Conversation between Caroline and Melanie",
      "Caroline: I went to the adoption meeting the Friday before."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Caroline go to the adoption meeting?", [
      {
        memoryId: "caroline-adoption-meeting",
        memoryType: "episodic_memory",
        content: "Caroline: I went to the adoption meeting the Friday before.",
        score: 1,
        artifactId: "artifact-caroline-adoption",
        occurredAt: "2023-07-15T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Caroline: I went to the adoption meeting the Friday before."
          }
        }
      }
    ]);

    assert.equal(claimText, "the friday before 15 July 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation uses generic joined-event identity for mentorship queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-join-event-"));
  const sourcePath = path.join(dir, "conv-26-session_31.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2023-07-17T00:00:00.000Z",
      "",
      "Conversation between Caroline and Melanie",
      "Caroline: I joined a mentorship program the weekend before."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText("When did Caroline join a mentorship program?", [
      {
        memoryId: "caroline-mentorship-program",
        memoryType: "episodic_memory",
        content: "Caroline: I joined a mentorship program the weekend before.",
        score: 1,
        artifactId: "artifact-caroline-mentorship",
        occurredAt: "2023-07-17T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: "Caroline: I joined a mentorship program the weekend before."
          }
        }
      }
    ]);

    assert.equal(claimText, "the weekend before July 17, 2023.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporal claim derivation uses generic read-event identity for book-title queries", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brain-temporal-read-event-"));
  const sourcePath = path.join(dir, "conv-26-session_22.md");
  writeFileSync(
    sourcePath,
    [
      "Captured: 2022-01-04T00:00:00.000Z",
      "",
      "Conversation between Melanie and Caroline",
      "Melanie: I finally read the book \"Nothing is Impossible\" this year."
    ].join("\n"),
    "utf8"
  );

  try {
    const claimText = deriveTemporalClaimText('When did Melanie read the book "Nothing is Impossible"?', [
      {
        memoryId: "melanie-read-book",
        memoryType: "episodic_memory",
        content: 'Melanie: I finally read the book "Nothing is Impossible" this year.',
        score: 1,
        artifactId: "artifact-melanie-read-book",
        occurredAt: "2022-01-04T00:00:00.000Z",
        namespaceId: "ns_temporal_anchor",
        provenance: {
          source_uri: sourcePath,
          metadata: {
            source_sentence_text: 'Melanie: I finally read the book "Nothing is Impossible" this year.'
          }
        }
      }
    ]);

    assert.equal(claimText, "The best supported year is 2022.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
