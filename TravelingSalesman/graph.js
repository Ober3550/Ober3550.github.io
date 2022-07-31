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
    this.currentState = "mst";
    this.mst_visited = [0];
    this.mst_unvisited = [...Array(this.nodes.length).keys()].slice(1);
    this.mst_iter = 0;
    this.pm_odds;
    this.pm_distances;
    this.pm_attempts = 0;
    this.pm_min_matching = [];
    this.pm_min_weight = Infinity;
    this.pm_draw_index = 0;
    this.pm_iter = 0;
    this.walk_current = 0;
    this.walk_ordered = [];
    this.walk_iter = 0;
    this.prune_nodes;
    this.prune_iter = 0;
    this.prune_visited = [];
    this.prune_rotated = false;
    this.prune_index = 0;
    this.prune_prev_index = 0;
  }
  add_edges(edges) {
    for (let i = 0; i < edges.length; i++) {
      this.add_edge(edges[i]);
    }
  }
  add_edge(edge) {
    edge.a.edges.push(edge);
    edge.b.edges.push(edge);
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
    while (this.mst_unvisited.length > 0) {
      let min_distance;
      let min_edge;
      for (let i = 0; i < this.mst_unvisited.length; i++) {
        for (let j = 0; j < this.mst_visited.length; j++) {
          this.mst_iter++;
          let nodeA = this.nodes[this.mst_visited[j]];
          let nodeB = this.nodes[this.mst_unvisited[i]];
          let newEdge = new Edge(nodeA, nodeB);
          if (min_distance == null || newEdge.weight < min_distance) {
            min_distance = newEdge.weight;
            min_edge = newEdge;
          }
        }
      }
      if (PART_UPDATE) {
        stroke(PALLETTE.blue);
        min_edge.draw();
        min_edge.a.draw();
        min_edge.b.draw();
      }
      this.add_edge(min_edge);
      let idxA = min_edge.a.index;
      let idxB = min_edge.b.index;
      if (!this.mst_visited.includes(idxA)) {
        this.mst_visited.push(idxA);
        this.mst_unvisited = this.mst_unvisited.filter((x) => {
          return x != idxA;
        });
      }
      if (!this.mst_visited.includes(idxB)) {
        this.mst_visited.push(idxB);
        this.mst_unvisited = this.mst_unvisited.filter((x) => {
          return x != idxB;
        });
      }
      if (PART_UPDATE) {
        break;
      }
    }
    if (PART_UPDATE) {
      if (this.mst_unvisited.length == 0) {
        this.currentState = "pm";
      }
    } else {
      let end = new Date();
      if (LOG_MST || LOG_TIMING) {
        //           MST   in   :
        //           MST   iter :
        //           MST   it/in:
        console.log("MST   in   : " + (end - start) + "ms");
        console.log("MST   iter : " + formatNumber(this.mst_iter));
        console.log(
          "MST   it/in: " +
            formatNumber(
              Math.floor(
                (this.mst_iter * 100) / (end - start == 0 ? 1 : end - start)
              ) / 100
            )
        );
      }
    }
  }
  perfectMatching() {
    let start = new Date();
    if (this.pm_odds == null) {
      this.pm_odds = this.nodes.filter((x) => {
        return x.edges.length % 2;
      });
    }
    if (this.pm_distances == null) {
      this.pm_distances = [];
      for (let i = 0; i < this.pm_odds.length; i++) {
        for (let j = i + 1; j < this.pm_odds.length; j++) {
          this.pm_distances.push(new Edge(this.pm_odds[i], this.pm_odds[j]));
        }
      }
      this.pm_distances = this.pm_distances.sort((a, b) => {
        return a.weight - b.weight;
      });
    }
    const MAX_ATTEMPTS = 20;
    if (LOG_PM) {
      console.log(
        "Matching edge count: " + formatNumber(this.pm_distances.length)
      );
    }
    while (this.pm_attempts < MAX_ATTEMPTS) {
      let matching = [];
      let weight = 0;
      let visited = [];
      for (let i = 0; i < this.pm_distances.length; i++) {
        this.pm_iter++;
        let index = (i + this.pm_attempts) % this.pm_distances.length;
        let nodeA = this.pm_distances[index].a.index;
        let nodeB = this.pm_distances[index].b.index;
        if (!visited.includes(nodeA) && !visited.includes(nodeB)) {
          weight += this.pm_distances[index].weight;
          matching.push(this.pm_distances[index]);
          visited.push(nodeA);
          visited.push(nodeB);
        }
        if (visited.length == this.pm_odds.length) {
          break;
        }
      }
      if (weight < this.pm_min_weight) {
        this.pm_min_matching = matching;
        this.pm_min_weight = weight;
        if (LOG_PM) {
          console.log("Attempt:", attempts);
          console.log("Min matching:", this.pm_min_matching);
          console.log("Min weight  :", this.pm_min_weight);
        }
      }
      this.pm_attempts++;
    }
    if (PART_UPDATE) {
      if (this.pm_draw_index < this.pm_min_matching.length) {
        stroke(PALLETTE.yellow);
        let drawEdge = this.pm_min_matching[this.pm_draw_index];
        drawEdge.draw();
        drawEdge.a.draw();
        drawEdge.b.draw();
        this.pm_draw_index++;
      } else {
        this.add_edges(this.pm_min_matching);
        this.currentState = "walk";
      }
    } else {
      this.add_edges(this.pm_min_matching);
    }
    if (!PART_UPDATE) {
      if (LOG_PM || LOG_TIMING) {
        let end = new Date();
        if (LOG_PM) {
          console.log("Attempts:", MAX_ATTEMPTS);
        }
        //           PM    in   :
        //           PM    iter :
        //           PM    it/in:
        console.log("PM    in   : " + (end - start) + "ms");
        console.log("PM    iter : " + formatNumber(this.pm_iter));
        console.log(
          "PM    it/in: " +
            formatNumber(
              Math.floor(
                (this.pm_iter * 100) / (end - start == 0 ? 1 : end - start)
              ) / 100
            )
        );
      }
    }
  }
  walkCycle() {
    let start = new Date();
    while (this.edges.length > 0) {
      let noEdges = true;
      for (let i = 0; i < this.edges.length; i++) {
        this.walk_iter++;
        if (this.edges[i].a.index == this.walk_current) {
          if (PART_UPDATE) {
            stroke(PALLETTE.red);
            this.edges[i].draw();
            stroke(PALLETTE.blue);
            this.nodes[this.walk_current].draw();
          }
          noEdges = false;
          this.walk_ordered.push(this.edges[i]);
          this.edges.splice(i, 1);
          this.walk_current =
            this.walk_ordered[this.walk_ordered.length - 1].b.index;
          if (PART_UPDATE) {
            stroke(PALLETTE.red);
            this.nodes[this.walk_current].draw();
          }
          break;
        } else if (this.edges[i].b.index == this.walk_current) {
          if (PART_UPDATE) {
            stroke(PALLETTE.red);
            this.edges[i].draw();
            stroke(PALLETTE.blue);
            this.nodes[this.walk_current].draw();
          }
          noEdges = false;
          let temp = this.edges[i].a;
          this.edges[i].a = this.edges[i].b;
          this.edges[i].b = temp;
          this.walk_ordered.push(this.edges[i]);
          this.walk_current =
            this.walk_ordered[this.walk_ordered.length - 1].b.index;
          this.edges.splice(i, 1);
          if (PART_UPDATE) {
            stroke(PALLETTE.red);
            this.nodes[this.walk_current].draw();
          }
          break;
        }
      }
      if (noEdges) {
        if (PART_UPDATE) {
          stroke(PALLETTE.blue);
          this.nodes[this.walk_current].draw();
        }
        // Rotate the array because the ordered list has created a closed cycle
        this.walk_ordered = arrayRotate(this.walk_ordered);
        this.walk_current =
          this.walk_ordered[this.walk_ordered.length - 1].b.index;
        if (PART_UPDATE) {
          stroke(PALLETTE.red);
          this.nodes[this.walk_current].draw();
        }
      }
      if (PART_UPDATE) {
        break;
      }
    }
    if (PART_UPDATE) {
      if (this.edges.length == 0) {
        this.currentState = "prune";
        this.add_edges(this.walk_ordered);
      }
    } else {
      this.add_edges(this.walk_ordered);
      let end = new Date();
      if (LOG_WALK || LOG_TIMING) {
        //           WALK  in   :
        //           WALK  iter :
        //           WALK  it/in:
        console.log("WALK  in   : " + (end - start) + "ms");
        console.log("WALK  iter : " + formatNumber(this.walk_iter));
        console.log(
          "WALK  it/in: " +
            formatNumber(
              Math.floor(
                (this.walk_iter * 100) / (end - start == 0 ? 1 : end - start)
              ) / 100
            )
        );
      }
    }
  }
  prune() {
    let start = new Date();
    if (this.prune_nodes == null) {
      this.prune_nodes = this.edges.map((x) => {
        return x.a.index;
      });
      this.prune_nodes.push(this.edges[this.edges.length - 1].b.index);
    }
    if (LOG_PRUNE) {
      console.log("Cycle        :", this.prune_nodes);
    }
    // Skip iterating if done
    if (this.prune_nodes.length == this.nodes.length + 1) {
      this.prune_index = this.prune_nodes.length;
    }
    while (this.prune_index < this.prune_nodes.length) {
      while(this.prune_index < this.prune_prev_index-1){
        if (
          !this.prune_visited.includes(this.prune_nodes[this.prune_index]) ||
          this.prune_index == this.prune_nodes.length - 1
        ) {
          this.prune_visited.push(this.prune_nodes[this.prune_index]);
        }else{
          // Break early
          break;
        }
        this.prune_index++;
      }
      if (
        this.prune_index == this.prune_nodes.length - 1 &&
        !this.prune_rotated
      ) {
        if (LOG_PRUNE) {
          console.log("Before rotate:", this.prune_nodes);
        }
        let tempRotate = this.prune_nodes.slice(1);
        this.prune_nodes = arrayRotate(tempRotate, false);
        this.prune_nodes.splice(
          0,
          0,
          this.prune_nodes[this.prune_nodes.length - 1]
        );
        this.prune_rotated = true;
        this.prune_prev_index = this.prune_index;
        this.prune_index = -1;
        this.prune_visited = [];
        if (LOG_PRUNE) {
          console.log("After  rotate:", this.prune_nodes);
        }
      }
      if (
        !this.prune_visited.includes(this.prune_nodes[this.prune_index]) ||
        this.prune_index == this.prune_nodes.length - 1
      ) {
        this.prune_visited.push(this.prune_nodes[this.prune_index]);
        if (PART_UPDATE && this.prune_index > 0) {
          let part_edge = new Edge(
            this.nodes[this.prune_nodes[this.prune_index - 1]],
            this.nodes[this.prune_nodes[this.prune_index]]
          );
          stroke(PALLETTE.green);
          part_edge.draw();
        }
      } else {
        for (let j = this.prune_index - 1; j >= 0; j--) {
          this.prune_iter++;
          if (this.prune_nodes[this.prune_index] == this.prune_nodes[j]) {
            let afterA =
              (this.prune_index + 1 + this.prune_nodes.length) %
              this.prune_nodes.length;
            let beforeB =
              (j - 1 + this.prune_nodes.length) % this.prune_nodes.length;
            if (beforeB < afterA + 1) {
              let subset = this.prune_nodes.slice(beforeB, afterA + 1);
              if (subset.length == 1) {
                if (LOG_PRUNE) {
                  console.log("Removed double end:", this.prune_nodes.pop());
                } else {
                  this.prune_nodes.pop();
                }
                break;
              }
              if (LOG_PRUNE) {
                console.log("i,j          :", this.prune_index, j);
                console.log(
                  "Node         :",
                  this.prune_nodes[this.prune_index]
                );
                console.log("Subset       :", subset);
              }
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
              if (LOG_PRUNE) {
                console.log("Min Edge     :", nodePaths[minEdgeIndex]);
                console.log("Min Weight   :", minWeight);
              }
              if (PART_UPDATE) {
                stroke(PALLETTE.green);
                drawEdges(minEdges);
              }
              this.prune_nodes.splice(
                beforeB,
                subset.length,
                ...nodePaths[minEdgeIndex]
              );
              this.prune_prev_index = this.prune_index;
              this.prune_index = -1;
              this.prune_visited = [];
            }
          }
        }
      }
      this.prune_index++;
      if (PART_UPDATE) {
        break;
      }
    }
    if (PART_UPDATE) {
      if (this.prune_index == this.prune_nodes.length) {
        let ordered = [];
        for (let i = 0; i < this.prune_nodes.length - 1; i++) {
          ordered.push(
            new Edge(
              this.nodes[this.prune_nodes[i]],
              this.nodes[this.prune_nodes[i + 1]]
            )
          );
        }
        this.remove_edges();
        this.add_edges(ordered);
        this.currentState = "done";
        console.log("done");
        console.log(this.prune_nodes);

        // Redraw everything
        background(BACKGROUND_COLOR);
        stroke(PALLETTE.blue);
        drawEdges(this.edges);
        drawNodes(this.nodes);
      }
    } else {
      let ordered = [];
      for (let i = 0; i < this.prune_nodes.length - 1; i++) {
        ordered.push(
          new Edge(
            this.nodes[this.prune_nodes[i]],
            this.nodes[this.prune_nodes[i + 1]]
          )
        );
      }
      this.remove_edges();
      this.add_edges(ordered);
      let end = new Date();
      if (LOG_PRUNE || LOG_TIMING) {
        if (LOG_PRUNE) {
          console.log("Pruned       :", this.prune_nodes);
        }
        //           PRUNE in   :
        //           PRUNE iter :
        //           PRUNE it/in:
        console.log("PRUNE in   : " + (end - start) + "ms");
        console.log("PRUNE iter : " + formatNumber(this.prune_iter));
        console.log(
          "PRUNE it/in: " +
            formatNumber(
              Math.floor(
                (this.prune_iter * 100) / (end - start == 0 ? 1 : end - start)
              ) / 100
            )
        );
      }
    }
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
  update() {
    switch (this.currentState) {
      case "mst":
        {
          console.log("mst");
          this.minSpanTree();
        }
        break;
      case "pm":
        {
          console.log("pm");
          this.perfectMatching();
        }
        break;
      case "walk":
        {
          console.log("walk");
          this.walkCycle();
        }
        break;
      case "prune":
        {
          console.log("prune");
          this.prune();
        }
        break;
    }
  }
}
