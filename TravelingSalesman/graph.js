class Graph {
  constructor(node_count, edge_count) {
    let nodes = [];
    let edges = [];
    for (let i = 0; i < node_count; i++) {
      let x = Math.floor(random(0, CANVAS_WIDTH));
      let y = Math.floor(random(0, CANVAS_HEIGHT));
      nodes.push(new Node(nodes.length, x, y));
    }
    for (let i = 0; i < edge_count; i++) {
      let nodeA = Math.floor(random(0, nodes.length - 1));
      let nodeB = Math.floor(random(0, nodes.length - 1));
      if (nodeA == nodeB) {
        i--;
        continue;
      }
      edges.push(new Edge(nodes[nodeA], nodes[nodeB]));
    }
    let weight = 0;
    for (let i = 0; i < edges.length; i++) {
      weight += edges[i].weight;
    }
    this.nodes = nodes;
    this.edges = edges;
    this.weight = weight;
  }
  add_edges(edges) {
    for (let i = 0; i < edges.length; i++) {
      edges[i].a.edges.push(edges[i]);
      edges[i].b.edges.push(edges[i]);
      this.add_edge(edges[i]);
    }
  }
  add_edge(edge) {
    this.edges.push(edge);
    this.weight += edge.weight;
  }
  remove_edges() {
    this.edges = [];
    this.weight = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i].edges = [];
    }
  }
  remove_edge(idx) {
    weight -= this.edges[idx];
    this.edges.splice(idx, 1);
  }
  minSpanTree() {
    let start = new Date();
    let iter = 0;
    let new_edges = [];
    let visited = [0];
    let unvisited = [...Array(this.nodes.length).keys()].slice(1);
    while (unvisited.length > 0) {
      let min_distance;
      let min_edge;
      for (let i = 0; i < unvisited.length; i++) {
        for (let j = 0; j < visited.length; j++) {
          iter++;
          let nodeA = this.nodes[visited[j]];
          let nodeB = this.nodes[unvisited[i]];
          let newEdge = new Edge(nodeA, nodeB);
          if (min_distance == null || newEdge.weight < min_distance) {
            min_distance = newEdge.weight;
            min_edge = newEdge;
          }
        }
      }
      new_edges.push(min_edge);
      let idxA = min_edge.a.index;
      let idxB = min_edge.b.index;
      if (!visited.includes(idxA)) {
        visited.push(idxA);
        unvisited = unvisited.filter((x) => {
          return x != idxA;
        });
      }
      if (!visited.includes(idxB)) {
        visited.push(idxB);
        unvisited = unvisited.filter((x) => {
          return x != idxB;
        });
      }
    }
    this.remove_edges();
    this.add_edges(new_edges);
    let end = new Date();
    if (LOG_MST) {
      console.log("MST took: " + (end - start) + "ms");
      console.log("MST iterations: " + formatNumber(iter));
      console.log(
        "Iter/ms: " +
          formatNumber(Math.floor((iter * 100) / (end - start)) / 100)
      );
    }
  }
  perfectMatching() {
    let start = new Date();
    let odds = this.nodes.filter((x) => {
      return x.edges.length % 2;
    });
    let evens = this.nodes.filter((x) => {
      return x.edges.length % 2 == 0;
    });
    let distances = [];
    for (let i = 0; i < odds.length; i++) {
      for (let j = i + 1; j < odds.length; j++) {
        distances.push(new Edge(odds[i], odds[j]));
      }
    }
    distances = distances.sort((a, b) => {
      return a.weight - b.weight;
    });
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    let min_matching = [];
    let min_weight = Infinity;
    let iter = 0;
    if (LOG_PM) {
      console.log("Matching edge count: " + formatNumber(distances.length));
    }
    while (attempts < MAX_ATTEMPTS) {
      let matching = [];
      let weight = 0;
      let visited = [];
      for (let i = 0; i < distances.length; i++) {
        iter++;
        let index = (i + attempts) % distances.length;
        let nodeA = distances[index].a.index;
        let nodeB = distances[index].b.index;
        if (!visited.includes(nodeA) && !visited.includes(nodeB)) {
          weight += distances[index].weight;
          matching.push(distances[index]);
          visited.push(nodeA);
          visited.push(nodeB);
        }
        if (visited.length == odds.length) {
          break;
        }
      }
      if (weight < min_weight) {
        min_matching = matching;
        min_weight = weight;
        if (LOG_PM) {
          console.log("Attempt:", attempts);
          console.log("Min matching:", min_matching);
          console.log("Min weight  :", min_weight);
        }
      }
      attempts++;
    }
    let end = new Date();
    if (LOG_PM) {
      console.log("Attempts:", MAX_ATTEMPTS);
      console.log("Perfect matching: " + (end - start) + "ms");
      console.log("Perfect matching iterations: " + formatNumber(iter));
      console.log(
        "Iter/ms: " +
          formatNumber(Math.floor((iter * 100) / (end - start)) / 100)
      );
    }
    this.add_edges(min_matching);
  }
  walkCycle() {
    let start = new Date();
    let current = 0;
    let ordered = [];
    while (this.edges.length > 0) {
      let noEdges = true;
      for (let i = 0; i < this.edges.length; i++) {
        if (this.edges[i].a.index == current) {
          noEdges = false;
          ordered.push(this.edges[i]);
          this.edges.splice(i, 1);
          current = ordered[ordered.length - 1].b.index;
          break;
        } else if (this.edges[i].b.index == current) {
          noEdges = false;
          let temp = this.edges[i].a;
          this.edges[i].a = this.edges[i].b;
          this.edges[i].b = temp;
          ordered.push(this.edges[i]);
          current = ordered[ordered.length - 1].b.index;
          this.edges.splice(i, 1);
          break;
        }
      }
      if (noEdges) {
        // Rotate the array because the ordered list has created a closed cycle
        ordered = arrayRotate(ordered);
        current = ordered[ordered.length - 1].b.index;
      }
    }
    let end = new Date();
    if (LOG_WALK) {
      console.log("Walked cycle: " + (end - start) + "ms");
    }
    this.remove_edges;
    this.add_edges(ordered);
  }
  prune() {
    let start = new Date();
    let nodes = this.edges.map((x) => {
      return x.a.index;
    });
    // Draw edges of previous cycle to demonstrate pruning
    stroke(PALLETTE.red);
    drawEdges(this.edges);
    if (LOG_PRUNE) {
      console.log("Cycle        :", nodes);
    }
    nodes.push(this.edges[this.edges.length - 1].b.index);
    let visited = [];
    let rotated = false;
    for (let i = 0; i < nodes.length; i++) {
      if (i == nodes.length - 1 && !rotated) {
        if (LOG_PRUNE) {
          console.log("Before rotate:", nodes);
        }
        let tempRotate = nodes.slice(1);
        nodes = arrayRotate(tempRotate, false);
        nodes.splice(0, 0, nodes[nodes.length - 1]);
        rotated = true;
        i = -1;
        visited = [];
        if (LOG_PRUNE) {
          console.log("After  rotate:", nodes);
        }
      }
      if (!visited.includes(nodes[i]) || i == nodes.length - 1) {
        visited.push(nodes[i]);
      } else {
        for (let j = i - 1; j >= 0; j--) {
          if (nodes[i] == nodes[j] && i != nodes.length - 1) {
            let beforeA = (i - 1 + nodes.length) % nodes.length;
            let afterA = (i + 1 + nodes.length) % nodes.length;
            let beforeB = (j - 1 + nodes.length) % nodes.length;
            let afterB = (j + 1 + nodes.length) % nodes.length;
            if (beforeB < afterA + 1) {
              let subset = nodes.slice(beforeB, afterA + 1);
              console.log("i,j          :", i, j);
              console.log("Node         :", nodes[i]);
              console.log("Subset       :", subset);
              let nodePaths = [
                JSON.parse(JSON.stringify(subset)),
                JSON.parse(JSON.stringify(subset)),
                [],
                [],
              ];
              nodePaths[0].splice(1, 1);
              nodePaths[1].splice(nodePaths[1].length - 2, 1);
              if (subset.length > 5) {
                nodePaths[2] = nodePaths[0]
                  .slice(1, nodePaths[0].length - 1)
                  .reverse();
                nodePaths[2].splice(0, 0, subset[0]);
                nodePaths[2].push(subset[subset.length - 1]);
                nodePaths[3] = nodePaths[1]
                  .slice(1, nodePaths[1].length - 1)
                  .reverse();
                nodePaths[3].splice(0, 0, subset[0]);
                nodePaths[3].push(subset[subset.length - 1]);
              }
              let edges = [[], []];
              for (let i = 0; i < nodePaths[0].length - 1; i++) {
                edges[0].push(
                  new Edge(
                    this.nodes[nodePaths[0][i]],
                    this.nodes[nodePaths[0][i + 1]]
                  )
                );
                edges[1].push(
                  new Edge(
                    this.nodes[nodePaths[1][i]],
                    this.nodes[nodePaths[1][i + 1]]
                  )
                );
                if (subset.length > 5) {
                  if (edges[2] == null) {
                    edges.push([]);
                  }
                  edges[2].push(
                    new Edge(
                      this.nodes[nodePaths[2][i]],
                      this.nodes[nodePaths[2][i + 1]]
                    )
                  );
                  if (edges[3] == null) {
                    edges.push([]);
                  }
                  edges[3].push(
                    new Edge(
                      this.nodes[nodePaths[3][i]],
                      this.nodes[nodePaths[3][i + 1]]
                    )
                  );
                }
              }
              let minEdgeIndex;
              let minEdges;
              let minWeight;
              for (let i = 0; i < edges.length; i++) {
                let edgeWeight = edgeWeights(edges[i]);
                if (minEdges == null || edgeWeight < minWeight) {
                  minEdgeIndex = i;
                  minEdges = edges[i];
                  minWeight = edgeWeight;
                }
              }
              if (LOG_ALL_EDGES && LOG_PRUNE) {
                console.log("EdgesA       :", nodePaths[0]);
                console.log("EdgesB       :", nodePaths[1]);
                if (subset.length > 5) {
                  console.log("EdgesC       :", nodePaths[2]);
                  console.log("EdgesD       :", nodePaths[3]);
                }
                console.log("WeightA      :", edgeWeights(edges[0]));
                console.log("WeightB      :", edgeWeights(edges[1]));
                if (subset.length > 5) {
                  console.log("WeightC      :", edgeWeights(edges[2]));
                  console.log("WeightD      :", edgeWeights(edges[3]));
                }
              }
              console.log("Min Edge     :", nodePaths[minEdgeIndex]);
              console.log("Min Weight   :", minWeight);
              nodes.splice(beforeB, subset.length, ...nodePaths[minEdgeIndex]);
              i = -1;
              visited = [];
            }
          }
        }
      }
    }
    let ordered = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      ordered.push(new Edge(this.nodes[nodes[i]], this.nodes[nodes[i + 1]]));
    }
    let end = new Date();
    if (LOG_PRUNE) {
      console.log("Pruned       :", nodes);
      console.log("Pruned in    :" + (end - start) + "ms");
    }
    this.remove_edges();
    this.add_edges(ordered);
  }
  christofides() {
    // MST
    // Perfect Matching
    // Walk Cycle
    // Prune
    this.minSpanTree();
    let mst_weight = this.weight;
    this.perfectMatching();
    this.walkCycle();
    this.prune();
    let finished_weight = this.weight;
    console.log("MST  :", mst_weight);
    console.log("DONE :", finished_weight);
    console.log("RATIO:", finished_weight / mst_weight);
  }
}
