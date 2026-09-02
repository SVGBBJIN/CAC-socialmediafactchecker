// The corroboration audit: a Corroborated verdict has to rest on a source that says the
// thing, not on one that is about the thing. See lib/corroboration.js.
//
// Pure, no network, no dependencies — the convention in CLAUDE.md. The "sources" here are
// ledger entries built by hand from the shape lib/search.js produces (title, url, snippet,
// domain) plus the `passages` a find adds.

import test from "node:test";
import assert from "node:assert/strict";

import {
  auditCorroboration,
  claimSpecifics,
  normalize,
  sourceConfirms,
  sourceEvidenceText,
} from "./lib/corroboration.js";
import { CitationLedger } from "./lib/citations.js";
import { splitClaims } from "./public/claims.js";

/** A ledger holding exactly these sources, numbered 1..n, as one search would have. */
function ledgerOf(...results) {
  const ledger = new CitationLedger();
  ledger.record({
    query: "q",
    claim: "c",
    provider: "test",
    retrievedAt: "2026-01-01",
    results: results.map((r) => ({ domain: new URL(r.url).hostname, snippet: "", ...r })),
  });
  return ledger;
}

const answerOf = (claim, body, verdict) => `[[claim: ${claim}]]\n${body}\nVERDICT: ${verdict}`;

/* ---------------------------------------------------------------- normalize */

test("normalize folds case, punctuation and abbreviation spelling together", () => {
  assert.equal(normalize("Rishi Sunak's U.S. visit"), "rishi sunak u s visit");
  assert.equal(normalize("405,000 vehicles"), "405000 vehicles");
  assert.equal(normalize("4.2% — in March 2024!"), "4.2 in march 2024");
  assert.equal(normalize("  “quoted”  "), "quoted");
});

/* ---------------------------------------------------------------- claimSpecifics */

test("claimSpecifics pulls names, figures and substantial words out of a claim", () => {
  const { entities, numbers, terms } = claimSpecifics(
    "The clip says Ofcom found UK inflation hit 11% in 2022",
  );
  // "UK" is demoted rather than required — see the note in `claimSpecifics` — and is too
  // short to survive the term filter, so what has to appear is the name, the figures and
  // the noun.
  assert.deepEqual(entities, ["ofcom"]);
  assert.deepEqual(numbers, ["11", "2022"]);
  assert.deepEqual(terms, ["inflation"]);
});

test("claimSpecifics does not read a figure out of a digit inside a name", () => {
  // The 19 of COVID-19 is part of a word. Counted as a figure it would both demand that
  // the page quote "19" and, being a second anchor, relax the word rule that is carrying
  // the check on a claim like this one.
  assert.deepEqual(claimSpecifics("Drinking bleach cures COVID-19").numbers, []);
  assert.deepEqual(claimSpecifics("The G7 met in 2024").numbers, ["2024"]);
});

test("claimSpecifics reads a possessive as the name it is", () => {
  assert.deepEqual(claimSpecifics("Ireland's population passed 5 million").entities, []);
  assert.ok(claimSpecifics("Germany's Angela Merkel resigned").entities.includes("angela merkel"));
});

test("claimSpecifics splits a long title into the parts a page can be checked for", () => {
  const { entities } = claimSpecifics("Rishi Sunak is the Prime Minister of the United Kingdom");
  assert.deepEqual(entities, ["rishi sunak", "prime minister", "united kingdom"]);
});

test("claimSpecifics does not read a name out of a sentence-opening ordinary word", () => {
  // "The" opens most claim labels; treating it as a name would make every source that
  // fails to print the word "the" a non-confirming one.
  assert.equal(claimSpecifics("The video claims the drug is banned").entities.length, 0);
});

test("claimSpecifics drops framing words from the terms it requires", () => {
  // A page that settles who currently holds an office has no reason to print "currently".
  assert.deepEqual(claimSpecifics("Keir Starmer is currently Prime Minister").terms, []);
});

/* ---------------------------------------------------------------- sourceEvidenceText */

test("sourceEvidenceText reads the page, including its slug and its read passages", () => {
  const text = sourceEvidenceText({
    title: "Election result",
    url: "https://gov.uk/government/people/keir-starmer",
    snippet: "Labour won.",
    domain: "gov.uk",
    passages: [{ text: "He was appointed on 5 July." }],
  });
  assert.match(text, /keir starmer/);
  assert.match(text, /appointed on 5 july/);
});

test("sourceEvidenceText never counts the model's own query or claim as evidence", () => {
  // Otherwise the claim confirms itself: search for it, and it is in the ledger entry.
  const text = sourceEvidenceText({
    title: "Prime Minister of the United Kingdom",
    url: "https://en.wikipedia.org/wiki/Prime_Minister_of_the_United_Kingdom",
    snippet: "The head of government.",
    claims: ["Rishi Sunak is the Prime Minister"],
    query: "Rishi Sunak Prime Minister",
  });
  assert.doesNotMatch(text, /sunak/);
});

/* ------------------------------------------------- sourceConfirms: known-false claims */

// Each of these is a claim that is false, paired with the kind of source a search for it
// actually returns: a page squarely on the subject that says nothing about the assertion.
// Every one of them used to be a green Corroborated badge.
const NON_CONFIRMING = [
  {
    name: "the office, not the officeholder",
    claim: "Rishi Sunak is the current Prime Minister of the United Kingdom",
    source: {
      title: "Prime Minister of the United Kingdom - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Prime_Minister_of_the_United_Kingdom",
      snippet:
        "The prime minister of the United Kingdom is the head of government of the United Kingdom. The prime minister advises the sovereign on the exercise of much of the royal prerogative.",
    },
  },
  {
    name: "a department's generic minister listing",
    claim: "Rishi Sunak is the current Prime Minister of the United Kingdom",
    source: {
      title: "Ministers - GOV.UK",
      url: "https://www.gov.uk/government/ministers",
      snippet:
        "Find out who runs government departments. Ministers are chosen by the Prime Minister from members of the House of Commons and House of Lords.",
    },
  },
  {
    name: "the topic page, not the figure",
    claim: "UK inflation hit 11% in 2022",
    source: {
      title: "Inflation and price indices - Office for National Statistics",
      url: "https://www.ons.gov.uk/economy/inflationandpriceindices",
      snippet:
        "Measures of inflation and prices in the UK, including the Consumer Prices Index and the Retail Prices Index.",
    },
  },
  {
    name: "the right subject, the wrong figure",
    claim: "UK inflation hit 11% in 2022",
    source: {
      title: "Consumer price inflation, UK: December 2022",
      url: "https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/december2022",
      snippet: "The Consumer Prices Index rose by 9.2% in the 12 months to December 2022.",
    },
  },
  {
    name: "a subject overview that never addresses the assertion",
    claim: "Vaccines cause autism",
    source: {
      title: "Vaccine safety - World Health Organization",
      url: "https://www.who.int/vaccine-safety",
      snippet:
        "Vaccines are held to the highest standard of safety. Every licensed vaccine goes through rigorous testing before approval.",
    },
  },
  {
    name: "a definition page for the mechanism named",
    claim: "5G networks spread coronavirus",
    source: {
      title: "What is 5G? - Ofcom",
      url: "https://www.ofcom.org.uk/spectrum/what-is-5g",
      snippet:
        "5G is the fifth generation of mobile networks, offering faster speeds and greater capacity than 4G.",
    },
  },
  {
    name: "an agency's homepage instead of its finding",
    claim: "The FDA approved ivermectin for treating COVID-19",
    source: {
      title: "Ivermectin - Drug information",
      url: "https://www.fda.gov/drugs/ivermectin",
      snippet:
        "Ivermectin is an antiparasitic drug. Some ivermectin products are intended for animals only.",
    },
  },
  {
    name: "the person, but nothing they are said to have said",
    claim: "Elon Musk said Tesla would accept Dogecoin for cars in 2021",
    source: {
      title: "Elon Musk - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Elon_Musk",
      snippet:
        "Elon Reeve Musk is a businessman known for his leadership of Tesla, SpaceX and X Corp.",
    },
  },
  {
    name: "an election page that never gives the result claimed",
    claim: "Donald Trump won the 2020 United States presidential election",
    source: {
      title: "2020 United States presidential election - Wikipedia",
      url: "https://en.wikipedia.org/wiki/2020_United_States_presidential_election",
      snippet:
        "The 2020 United States presidential election was the 59th quadrennial presidential election, held on November 3, 2020.",
    },
  },
  {
    name: "a climate portal that never mentions the claimed pause",
    claim: "Global temperatures have not risen since 1998",
    source: {
      title: "Climate change - NASA",
      url: "https://climate.nasa.gov/",
      snippet: "Vital signs of the planet: global climate change and global warming.",
    },
  },
];

for (const { name, claim, source } of NON_CONFIRMING) {
  test(`sourceConfirms rejects topical overlap — ${name}`, () => {
    const result = sourceConfirms(claim, { domain: new URL(source.url).hostname, ...source });
    assert.equal(result.confirms, false, `expected no confirmation from ${source.url}`);
    assert.ok(result.missing.length > 0, "a rejection must say what the source never mentioned");
  });
}

/* ------------------------------------------------- sourceConfirms: genuine confirmation */

const CONFIRMING = [
  {
    name: "the officeholder, named",
    claim: "Keir Starmer is the Prime Minister of the United Kingdom",
    source: {
      title: "Prime Minister - GOV.UK",
      url: "https://www.gov.uk/government/ministers/prime-minister",
      snippet:
        "The Rt Hon Sir Keir Starmer KCB KC MP has been Prime Minister of the United Kingdom since July 2024.",
    },
  },
  {
    name: "the figure, in the source's own wording",
    claim: "UK inflation hit 11% in 2022",
    source: {
      title: "Consumer price inflation, UK: October 2022",
      url: "https://www.ons.gov.uk/economy/bulletins/october2022",
      snippet:
        "UK inflation rose to 11 percent in the 12 months to October 2022, the highest rate in 41 years.",
    },
  },
  {
    name: "a passage pulled by find_in_page rather than a snippet",
    claim: "The bridge closure started on Monday",
    source: {
      title: "Traffic notice",
      url: "https://example.gov/notices/42",
      snippet: "Traffic notices for the county.",
      passages: [{ text: "The bridge was closed to all traffic from Monday morning." }],
    },
  },
  {
    name: "an abbreviation the claim spelled out",
    claim: "The NHS employs more than 1.3 million people in the United Kingdom",
    source: {
      title: "NHS workforce statistics",
      url: "https://digital.nhs.uk/workforce",
      snippet:
        "The National Health Service employed 1.3 million staff across the UK in the latest quarter.",
    },
  },
];

for (const { name, claim, source } of CONFIRMING) {
  test(`sourceConfirms accepts a source that carries the specific fact — ${name}`, () => {
    const result = sourceConfirms(claim, { domain: new URL(source.url).hostname, ...source });
    assert.equal(result.confirms, true, `missing: ${result.missing.join(", ")}`);
  });
}

test("sourceConfirms leaves a claim with nothing specific in it alone", () => {
  // Nothing to look for means nothing to check, and the model's verdict stands.
  assert.equal(sourceConfirms("It is true", { title: "x", url: "https://e.com/" }).confirms, true);
});

test("sourceConfirms treats a source with no readable text as confirming nothing", () => {
  assert.equal(sourceConfirms("Keir Starmer is Prime Minister", {}).confirms, false);
});

/* ---------------------------------------------------------------- auditCorroboration */

const GENERIC_PM = {
  title: "Prime Minister of the United Kingdom - Wikipedia",
  url: "https://en.wikipedia.org/wiki/Prime_Minister_of_the_United_Kingdom",
  snippet: "The prime minister of the United Kingdom is the head of government.",
};
const MINISTERS = {
  title: "Ministers - GOV.UK",
  url: "https://www.gov.uk/government/ministers",
  snippet: "Find out who runs government departments.",
};
const STARMER = {
  title: "Prime Minister - GOV.UK",
  url: "https://www.gov.uk/government/ministers/prime-minister",
  snippet: "Sir Keir Starmer has been Prime Minister of the United Kingdom since July 2024.",
};

test("auditCorroboration downgrades a Corroborated claim its sources only share a topic with", () => {
  const answer = answerOf(
    "Rishi Sunak is the current Prime Minister of the United Kingdom",
    "Both sources describe the office [1][2].",
    "Corroborated",
  );
  const audited = auditCorroboration(answer, ledgerOf(GENERIC_PM, MINISTERS));

  assert.equal(audited.changed, true);
  assert.equal(splitClaims(audited.text)[0].verdictKey, "insufficient");
  assert.equal(audited.downgrades.length, 1);
  assert.deepEqual(audited.downgrades[0].cited, [1, 2]);
  assert.ok(audited.downgrades[0].missing.includes("rishi sunak"));
  assert.match(audited.text, /rishi sunak/i);
});

test("auditCorroboration leaves the prose and the markers of a downgraded claim alone", () => {
  const answer = answerOf("Rishi Sunak is the Prime Minister", "Generic page [1].", "Corroborated");
  const { text } = auditCorroboration(answer, ledgerOf(GENERIC_PM));
  assert.match(text, /^\[\[claim: Rishi Sunak is the Prime Minister\]\]\nGeneric page \[1\]\./);
  assert.match(text, /VERDICT: Insufficient evidence$/);
});

test("auditCorroboration keeps a Corroborated verdict its source actually carries", () => {
  const answer = answerOf(
    "Keir Starmer is the Prime Minister of the United Kingdom",
    "The government's own page names him [1].",
    "Corroborated",
  );
  assert.equal(auditCorroboration(answer, ledgerOf(STARMER)).changed, false);
});

test("auditCorroboration accepts a claim when any one cited source confirms it", () => {
  const answer = answerOf(
    "Keir Starmer is the Prime Minister of the United Kingdom",
    "Background [1], and the appointment itself [2].",
    "Corroborated",
  );
  assert.equal(auditCorroboration(answer, ledgerOf(GENERIC_PM, STARMER)).changed, false);
});

test("auditCorroboration downgrades a Corroborated claim that cites nothing at all", () => {
  const answer = answerOf("Rishi Sunak is the Prime Minister", "It is well known.", "Corroborated");
  const audited = auditCorroboration(answer, ledgerOf(STARMER));
  assert.equal(audited.changed, true);
  assert.deepEqual(audited.downgrades[0].cited, []);
});

test("auditCorroboration only moves verdicts one way", () => {
  // Contradicted, Disputed and Insufficient evidence are never touched: this pass can
  // withhold a finding, never manufacture one.
  for (const verdict of ["Contradicted", "Disputed", "Insufficient evidence"]) {
    const answer = answerOf("Rishi Sunak is the Prime Minister", "Only the office [1].", verdict);
    assert.equal(auditCorroboration(answer, ledgerOf(GENERIC_PM)).changed, false, verdict);
  }
});

test("auditCorroboration audits each claim of a multi-claim answer on its own sources", () => {
  const answer = [
    answerOf(
      "Keir Starmer is the Prime Minister of the United Kingdom",
      "The government's page names him [2].",
      "Corroborated",
    ),
    answerOf(
      "Rishi Sunak is the current Prime Minister of the United Kingdom",
      "An article about the office [1].",
      "Corroborated",
    ),
  ].join("\n");
  const audited = auditCorroboration(answer, ledgerOf(GENERIC_PM, STARMER));
  const claims = splitClaims(audited.text);

  assert.equal(claims.length, 2);
  assert.equal(claims[0].verdictKey, "corroborated");
  assert.equal(claims[1].verdictKey, "insufficient");
  assert.equal(audited.downgrades.length, 1);
});

test("auditCorroboration handles a verdict alias the same as the canonical label", () => {
  const answer = answerOf("Rishi Sunak is the Prime Minister", "The office page [1].", "True");
  const audited = auditCorroboration(answer, ledgerOf(GENERIC_PM));
  assert.equal(audited.changed, true);
  assert.match(audited.text, /VERDICT: Insufficient evidence$/);
});

test("auditCorroboration is a no-op on answers it has nothing to say about", () => {
  const ledger = ledgerOf(STARMER);
  // A greeting: no claim markers at all.
  assert.equal(auditCorroboration("Hi! Paste a link and I'll check it.", ledger).changed, false);
  // A claim cut off before its verdict line arrived.
  assert.equal(auditCorroboration("[[claim: One]]\nstill checking", ledger).changed, false);
  // Nothing was retrieved, so there is nothing to audit against.
  const answer = answerOf("Rishi Sunak is the Prime Minister", "As is known.", "Corroborated");
  assert.equal(auditCorroboration(answer, new CitationLedger()).changed, false);
  assert.equal(auditCorroboration(answer, null).changed, false);
});

test("auditCorroboration ignores a marker the ledger cannot resolve", () => {
  // Cleanup deletes it moments later; it is not evidence of anything in the meantime.
  const answer = answerOf("Rishi Sunak is the Prime Minister", "Invented source [9].", "Corroborated");
  const audited = auditCorroboration(answer, ledgerOf(STARMER));
  assert.equal(audited.changed, true);
  assert.deepEqual(audited.downgrades[0].cited, []);
});

test("a batch of 'X holds office Y' claims never gets corroborated by a generic office page alone", () => {
  // Manual verification requested against a prior finding: a Corroborated verdict resting
  // on a source that is merely on-topic (a generic office/role reference page) rather than
  // one that actually names the officeholder. Mix of true and deliberately false claims —
  // sourceConfirms is not an entailment checker (see the test below), so truth doesn't
  // matter here; what matters is that a source never naming the person can't corroborate a
  // claim about who that person is.
  const cases = [
    ["Kim Jong Un is the President of the United States", "The President of the United States is the head of state and head of government, elected every four years."],
    ["Vladimir Putin is the Prime Minister of the United Kingdom", "The Prime Minister of the United Kingdom is the head of His Majesty's Government, appointed by the monarch."],
    ["Xi Jinping is the Chancellor of Germany", "The Chancellor of Germany is the head of the federal government, elected by the Bundestag."],
    ["Emmanuel Macron is the Prime Minister of Japan", "The Prime Minister of Japan is the head of government and leader of the Cabinet."],
    ["Narendra Modi is the President of Brazil", "The President of Brazil is both head of state and head of government of the Federative Republic."],
    ["Justin Trudeau is the President of Mexico", "The President of Mexico is the head of state and head of government of the United Mexican States."],
    ["Rishi Sunak is the Chancellor of Austria", "The Chancellor of Austria heads the federal government and is appointed by the Federal President."],
    ["Olaf Scholz is the King of Spain", "The Monarchy of Spain is a constitutional monarchy; the King is the head of state."],
    ["Volodymyr Zelenskyy is the President of Russia", "The President of Russia is the head of state, elected for a six-year term."],
    ["Benjamin Netanyahu is the Prime Minister of Italy", "The Prime Minister of Italy, formally the President of the Council of Ministers, leads the Council."],
    ["Joe Biden is the President of the United States", "The President is elected to a four-year term and serves as commander-in-chief."],
    ["Donald Trump is the Prime Minister of the United Kingdom", "Number 10 Downing Street is the official residence of the Prime Minister."],
    ["Recep Tayyip Erdogan is the President of France", "The President of France is elected for a five-year term as head of state of the Republic."],
    ["Anthony Albanese is the President of South Korea", "The President of South Korea is the head of state, directly elected for one five-year term."],
    ["Ursula von der Leyen is the Prime Minister of Canada", "The Prime Minister of Canada chairs the Cabinet and advises the monarch as the Crown's primary minister."],
  ];

  for (const [claim, generic] of cases) {
    const answer = answerOf(claim, `Sources checked [1].`, "Corroborated");
    // Deliberately generic title/URL too — a slug or headline naming the person would leak
    // the answer into the "evidence" via sourceEvidenceText and defeat the point of the case.
    const ledger = ledgerOf({
      title: "Office overview - government reference page",
      url: "https://example.org/office-reference",
      snippet: generic,
    });
    const audited = auditCorroboration(answer, ledger);
    assert.equal(audited.changed, true, `expected a downgrade for: ${claim}`);
    assert.equal(audited.downgrades[0]?.title, claim);
  }
});

test("a source that actually names the officeholder is left as Corroborated", () => {
  // Positive control for the batch above: the mechanism isn't simply refusing every
  // Corroborated verdict, only ones a generic source can't back up.
  const answer = answerOf("Joe Biden is the President of the United States", "The Wikipedia page [1].", "Corroborated");
  const ledger = ledgerOf({
    title: "Joe Biden - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Joe_Biden",
    snippet: "Joe Biden is the President of the United States, having taken office in January 2021.",
  });
  const audited = auditCorroboration(answer, ledger);
  assert.equal(audited.changed, false);
});

test("the audit checks what a source is about, not whether it entails the claim", () => {
  // Stated as a test because it is the boundary of the mechanism rather than a gap in it.
  // A page reporting that measles cases rose contains every name and figure of a claim that
  // measles was eradicated; no amount of word-matching sees the contradiction, and reaching
  // for one would mean guessing at meaning — the thing this app tore out. Catching this is
  // the model's job, and the WHAT COUNTS AS CORROBORATION section of the system prompt is
  // where it is asked to do it.
  const rose = {
    title: "Measles in Europe",
    url: "https://www.who.example/europe/measles-2023",
    snippet: "Measles cases across the European region increased more than thirtyfold in 2023.",
  };
  assert.equal(sourceConfirms("Measles was eradicated in Europe in 2023", rose).confirms, true);
});
