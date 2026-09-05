import { SourcePills } from "@trase/design-system";

const sources = [
  { url: "https://apnews.com/article/example", domain: "apnews.com", title: "AP News: fact-check context" },
  { url: "https://reuters.com/fact-check/example", domain: "reuters.com", title: "Reuters fact check" },
  { url: "https://who.int/news/example", domain: "who.int", title: "World Health Organization" },
];

export const Default = () => <SourcePills sources={sources} />;
export const WithMore = () => <SourcePills sources={sources} moreCount={4} />;
export const Single = () => <SourcePills sources={sources.slice(0, 1)} />;
