import React from 'react';
import { useNavigate } from 'react-router-dom';

// Builds a nested tree from the flat { id, parent_id, ... } list the API
// returns, then renders it recursively. Works for any subtree depth.
function buildTree(people) {
  const byId = new Map(people.map((p) => [p.id, { ...p, children: [] }]));
  const roots = [];
  for (const p of byId.values()) {
    if (p.parent_id && byId.has(p.parent_id)) {
      byId.get(p.parent_id).children.push(p);
    } else {
      roots.push(p);
    }
  }
  return roots;
}

function Node({ node, onAddChild }) {
  const navigate = useNavigate();
  return (
    <div>
      <div className="tree-node-label" onClick={() => navigate(`/profile/${node.id}`)}>
        <strong>{node.name}</strong>{' '}
        <span className="pill">{node.role_title}</span>{' '}
        <button
          className="secondary"
          style={{ padding: '2px 8px', fontSize: 12, marginLeft: 8 }}
          onClick={(e) => { e.stopPropagation(); onAddChild(node); }}
        >
          + Add subordinate
        </button>
      </div>
      {node.children.map((child) => (
        <div className="tree-node" key={child.id}>
          <Node node={child} onAddChild={onAddChild} />
        </div>
      ))}
    </div>
  );
}

export default function TreeView({ people, onAddChild }) {
  const roots = buildTree(people);
  return (
    <div>
      {roots.map((root) => (
        <Node key={root.id} node={root} onAddChild={onAddChild} />
      ))}
    </div>
  );
}
