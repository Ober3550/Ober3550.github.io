class Node {
  constructor(index = 0, x, y) {
    this.index = index;
    this.x = x;
    this.y = y;
    this.edges = [];
  }
  draw() {
    circle(this.x, this.y, NODE_SIZE);
    textSize(NODE_SIZE * 0.8);
    textAlign(CENTER, CENTER);
    text("" + this.index, this.x, this.y);
  }
  draw_edges() {
    drawEdges(this.edges);
  }
  dist(other) {
    let a2 = Math.pow(this.x - other.x, 2);
    let b2 = Math.pow(this.y - other.y, 2);
    return Math.sqrt(a2 + b2);
  }
}
class Edge {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.weight = a.dist(b);
  }
  draw() {
    line(this.a.x, this.a.y, this.b.x, this.b.y);
  }
}
function nodeEdgeWeights(nodes) {
  let weight = 0;
  for (let i = 0; i < nodes.length; i++) {
    weight += edgeWeights(nodes[i].edges);
  }
  return weight;
}
function edgeWeights(edges) {
  let weight = 0;
  for (let i = 0; i < edges.length; i++) {
    weight += edges[i].weight;
  }
  return weight;
}
function drawEdges(edges) {
  for (let i = 0; i < edges.length; i++) {
    edges[i].draw();
  }
}
function drawNodeEdges(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].draw_edges();
  }
}
function drawNodes(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].draw();
  }
}
function formatNumber(x) {
  var parts = x.toString().split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}
function arrayRotate(arr, reverse = true) {
  if (reverse) arr.unshift(arr.pop());
  else arr.push(arr.shift());
  return arr;
}
