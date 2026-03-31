import test from "node:test";
import assert from "node:assert/strict";

import {
  extractMediaMentions,
  getTypedMediaResults,
  parseMediaTitleFromSentence
} from "../dist/typed-memory/service.js";

test("parseMediaTitleFromSentence canonicalizes Eternal Sunshine from sidecar metadata", () => {
  const title = parseMediaTitleFromSentence(
    "Joanna: It's such a good one. image query: eternal sunshine of the spotless mind movie poster. image caption: a photo of a poster."
  );

  assert.equal(title, "Eternal Sunshine of the Spotless Mind");
});

test("parseMediaTitleFromSentence rejects generic film-festival and movies noise", () => {
  assert.equal(
    parseMediaTitleFromSentence("Now I'm gonna submit it to some film festivals and get producers to check it out."),
    null
  );
  assert.equal(
    parseMediaTitleFromSentence("Joanna watched movies and exploring nature."),
    null
  );
});

test("extractMediaMentions carries a sidecar title into favorite and first-watch follow-up turns", () => {
  const text = [
    "Conversation between Joanna and Nate",
    "Joanna: Yeah, totally! Have you seen this romantic drama that's all about memory and relationships? It's such a good one. [image: a photo of a poster of a man and a woman sitting on a bench]",
    "--- image_query: eternal sunshine of the spotless mind movie poster",
    "--- image_caption: a photo of a poster of a man and a woman sitting on a bench",
    "Nate: Oh cool! I might check that one out some time soon! I do love watching classics.",
    "Joanna: Yep, that movie is awesome. I first watched it around 3 years ago. I even went out and got a physical copy!",
    "--- image_query: eternal sunshine of spotless mind dvd cover",
    "--- image_caption: a photo of a dvd on a table with a blurry background",
    "Joanna: A few times. It's one of my favorites! I really like the idea and the acting."
  ].join("\n");

  const mentions = extractMediaMentions(text, ["Joanna", "Nate"], "2022-01-21T19:31:00.000Z");
  const eternal = mentions.filter((mention) => mention.mediaTitle === "Eternal Sunshine of the Spotless Mind");

  assert.ok(eternal.some((mention) => mention.subjectName === "Joanna"));
  assert.ok(eternal.some((mention) => mention.favoriteSignal === true));
  assert.ok(eternal.some((mention) => mention.timeHintText === "around 3 years ago"));
});

test("extractMediaMentions does not treat inline image labels as speaker turns", () => {
  const text = [
    "Joanna: Yeah, totally! Have you seen this romantic drama that's all about memory and relationships? It's such a good one. [image: a photo of a poster of a man and a woman sitting on a bench]",
    "--- image_query: eternal sunshine of the spotless mind movie poster",
    "--- image_caption: a photo of a poster of a man and a woman sitting on a bench",
    "Nate: Oh cool! I might check that one out some time soon! I do love watching classics.",
    "Joanna: Yep, that movie is awesome. I first watched it around 3 years ago. I even went out and got a physical copy! [image: a photo of a dvd on a table with a blurry background]",
    "--- image_query: eternal sunshine of spotless mind dvd cover",
    "--- image_caption: a photo of a dvd on a table with a blurry background",
    "Joanna: A few times. It's one of my favorites! I really like the idea and the acting."
  ].join("\n");

  const mentions = extractMediaMentions(text, ["Joanna", "Nate"], "2023-01-01T00:00:00.000Z");
  const eternal = mentions.filter((mention) => mention.mediaTitle === "Eternal Sunshine of the Spotless Mind");

  assert.ok(eternal.length >= 2);
  assert.ok(eternal.every((mention) => mention.subjectName === "Joanna"));
  assert.ok(eternal.some((mention) => mention.favoriteSignal === true));
  assert.ok(eternal.some((mention) => mention.timeHintText === "around 3 years ago"));
});

test("extractMediaMentions can carry a media title across adjacent truncated chunks", () => {
  const recommendationChunk = [
    "It's such a good one. [image: a photo of a poster of a man and a woman sitting on a bench]",
    "--- image_query: eternal sunshine of the spotless mind movie poster",
    "--- image_caption: a photo of a poster of a man and a woman sitting on a bench",
    "Nate: Oh cool! I might check that one out some time soon!"
  ].join("\n");
  const firstChunkMentions = extractMediaMentions(
    recommendationChunk,
    ["Joanna", "Nate"],
    "2023-01-01T00:00:00.000Z",
    { defaultSpeakerName: "Joanna" }
  );
  const anchor = firstChunkMentions.find((mention) => mention.mediaTitle === "Eternal Sunshine of the Spotless Mind");

  assert.ok(anchor);
  assert.equal(anchor.subjectName, "Joanna");

  const favoriteChunk = "sounds like you know the movie well! Joanna: A few times. It's one of my favorites!";
  const favoriteMentions = extractMediaMentions(
    favoriteChunk,
    ["Joanna", "Nate"],
    "2023-01-01T00:00:00.000Z",
    {
      seedSubjectMedia: new Map([["joanna", { mediaTitle: anchor.mediaTitle, mediaKind: anchor.mediaKind }]]),
      seedGlobalMedia: { mediaTitle: anchor.mediaTitle, mediaKind: anchor.mediaKind }
    }
  );
  const carriedFavorite = favoriteMentions.find((mention) => mention.mediaTitle === "Eternal Sunshine of the Spotless Mind");

  assert.ok(carriedFavorite);
  assert.equal(carriedFavorite.subjectName, "Joanna");
  assert.equal(carriedFavorite.favoriteSignal, true);
  assert.equal(carriedFavorite.carryForwardSignal, true);
});

test("getTypedMediaResults recovers a trailing unmatched quoted title", async () => {
  const results = await getTypedMediaResults({
    namespaceId: "debug_locomo_conv42_focus",
    query: 'When did Joanna first watch "Eternal Sunshine of the Spotless Mind?',
    referenceNow: "2026-03-30T00:00:00.000Z"
  });

  assert.ok(results.some((row) => row.provenance.media_title === "Eternal Sunshine of the Spotless Mind"));
});
