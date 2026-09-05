import { LibraryItem } from "@trase/design-system";

export const Corroborated = () => (
  <ul style={{ listStyle: "none", margin: 0, padding: 0, width: 260 }}>
    <LibraryItem title="Did NASA fake the moon landing?" platform="YouTube" status="corroborated" statusLabel="Corroborated" />
  </ul>
);

export const Active = () => (
  <ul style={{ listStyle: "none", margin: 0, padding: 0, width: 260 }}>
    <LibraryItem title="Viral claim about vaccine ingredients" platform="TikTok" status="contradicted" statusLabel="Contradicted" active />
  </ul>
);

export const Running = () => (
  <ul style={{ listStyle: "none", margin: 0, padding: 0, width: 260 }}>
    <LibraryItem title="Is this clip of the senator real?" platform="Instagram" status="running" statusLabel="Checking…" />
  </ul>
);
