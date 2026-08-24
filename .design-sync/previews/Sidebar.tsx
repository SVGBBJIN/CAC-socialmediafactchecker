import { useState } from "react";
import { Sidebar, LibraryItem } from "@seer/design-system";

export const Default = () => {
  const [search, setSearch] = useState("");
  return (
    <div style={{ height: 420 }}>
      <Sidebar searchValue={search} onSearchChange={setSearch}>
        <LibraryItem title="Did NASA fake the moon landing?" platform="YouTube" status="corroborated" statusLabel="Corroborated" active />
        <LibraryItem title="Viral claim about vaccine ingredients" platform="TikTok" status="contradicted" statusLabel="Contradicted" />
        <LibraryItem title="Is this clip of the senator real?" platform="Instagram" status="running" statusLabel="Checking…" />
      </Sidebar>
    </div>
  );
};

export const Collapsed = () => (
  <div style={{ height: 420 }}>
    <Sidebar collapsed />
  </div>
);

export const Empty = () => (
  <div style={{ height: 300 }}>
    <Sidebar>
      <li className="lib-empty">No checks yet — paste a link below.</li>
    </Sidebar>
  </div>
);
