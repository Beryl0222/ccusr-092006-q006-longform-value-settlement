// 反作弊图谱：同一控制关系（并查集）与互刷闭环（有向图强连通分量）。
//
// 数据来源是去标识化的伪标识：作者 id 与观众 viewer_key 处在同一伪标识空间，
// CONTROL_LINK_DECLARED 事件声明“这些伪标识受同一主体控制”（设备群、机构矩阵号等）。
// 图谱本身不含真实身份，只回答两个结算问题：
//   1. viewer 与作者是否在同一控制关系内 -> SAME_CONTROL / SELF；
//   2. viewer→作者 的互动是否落在互刷闭环里 -> RECIPROCAL（A→B→A 式循环，非真实回访）。

export class ControlGraph {
  constructor(events) {
    this.parent = new Map();
    for (const e of events) {
      if (e.kind !== "CONTROL_LINK_DECLARED") continue;
      const entities = e.payload.entities ?? [];
      for (const id of entities) {
        if (!this.parent.has(id)) this.parent.set(id, id);
      }
      for (let i = 1; i < entities.length; i++) this._union(entities[0], entities[i]);
    }

    // 互刷环：由全部互动信号建立有向边 viewer -> author，Tarjan 求 SCC。
    this.adj = new Map();
    // authorOf 由调用方在 build 时注入（图谱只认伪标识，不认作品台账）。
    this._pendingEdges = [];
    for (const e of events) {
      if (e.kind === "VALUE_SIGNAL") this._pendingEdges.push(e);
    }
  }

  _addEdge(u, v) {
    if (u === v) return; // 自我互动单独判定，不进环
    if (!this.adj.has(u)) this.adj.set(u, new Set());
    this.adj.get(u).add(v);
    if (!this.parent.has(u)) this.parent.set(u, u);
    if (!this.parent.has(v)) this.parent.set(v, v);
  }

  /** 由台账层注入 work_id -> author_id 的解析，建立互动边。 */
  resolveEdges(authorOfWork) {
    for (const e of this._pendingEdges) {
      const author = authorOfWork(e.payload.work_id);
      const viewer = e.payload.viewer_key;
      if (author && viewer) this._addEdge(viewer, author);
    }
    this._rings = this._tarjan();
  }

  _find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== x) {
      const next = this.parent.get(x);
      this.parent.set(x, root);
      x = next;
    }
    return root;
  }

  _union(a, b) {
    const ra = this._find(a);
    const rb = this._find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  /** 同一控制关系：两伪标识被声明连通即成立。 */
  sameController(a, b) {
    if (!a || !b || !this.parent.has(a) || !this.parent.has(b)) return false;
    return this._find(a) === this._find(b);
  }

  /**
   * 互刷闭环：viewer 与 author 同属一个大小 >=2 的强连通分量。
   * 闭环节点集合在 resolveEdges 后确定。
   */
  inReciprocalRing(viewer, author) {
    if (!this._rings) throw new Error("ControlGraph 尚未 resolveEdges");
    if (!viewer || !author || viewer === author) return false;
    const g1 = this._rings.get(viewer);
    return g1 !== undefined && g1 === this._rings.get(author);
  }

  _tarjan() {
    let index = 0;
    const indices = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const groupOf = new Map();
    let group = 0;
    const groupSize = new Map();

    const nodes = new Set(this.adj.keys());
    for (const outs of this.adj.values()) for (const v of outs) nodes.add(v);

    const strongConnect = (v) => {
      indices.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      for (const w of this.adj.get(v) ?? []) {
        if (!indices.has(w)) {
          strongConnect(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), indices.get(w)));
        }
      }
      if (low.get(v) === indices.get(v)) {
        const members = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          members.push(w);
        } while (w !== v);
        if (members.length >= 2) {
          for (const m of members) groupOf.set(m, group);
          groupSize.set(group, members.length);
        }
        group++;
      }
    };

    for (const v of nodes) if (!indices.has(v)) strongConnect(v);
    return groupOf;
  }

  /** 结算单证据：给出 viewer 所在闭环规模，便于人工复核。 */
  ringEvidence(viewer, author) {
    if (!this.inReciprocalRing(viewer, author)) return null;
    let size = 0;
    const g = this._rings.get(viewer);
    for (const [, gg] of this._rings) if (gg === g) size++;
    return { ring_group: g, ring_size: size };
  }
}
