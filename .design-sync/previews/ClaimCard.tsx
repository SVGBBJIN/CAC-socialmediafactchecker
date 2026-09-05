import { ClaimCard, TimestampChip } from "@trase/design-system";

const sources = [
  { url: "https://apnews.com/article/example", domain: "apnews.com", title: "AP News" },
  { url: "https://reuters.com/fact-check/example", domain: "reuters.com", title: "Reuters" },
];

export const WholeAnswer = () => (
  <div style={{ width: 360 }}>
    <ClaimCard verdict="corroborated" sources={sources}>
      The clip is authentic and matches footage from the original broadcast{" "}
      <TimestampChip label="0:12" />.
    </ClaimCard>
  </div>
);

export const SplitPane = () => (
  <div style={{ width: 360 }}>
    <ClaimCard
      eyebrow="Claim 1 of 3"
      title="The vaccine contains microchips"
      verdict="contradicted"
      sources={sources}
    >
      No credible source supports this. The claim traces to a 2021 hoax article.
    </ClaimCard>
  </div>
);

export const Pending = () => (
  <div style={{ width: 360 }}>
    <ClaimCard eyebrow="Claim 2 of 3" pending title="The senator voted against the bill">
      Checking…
    </ClaimCard>
  </div>
);
