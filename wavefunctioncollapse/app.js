function isMobileDevice() {
  var check = false;
  (function (a) {
    if (
      /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(
        a
      ) ||
      /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(
        a.substr(0, 4)
      )
    )
      check = true;
  })(navigator.userAgent || navigator.vendor || window.opera);
  return check;
}
const IS_MOBILE = isMobileDevice();
const tileImages = {};
let settings = {
  circuit: {
    IMAGE_COUNT: 9,
    IMAGE_SIZE_PX: 14,
  },
  coast: {
    IMAGE_COUNT: 8,
    IMAGE_SIZE_PX: 10,
  },
  pipe_tiles: {
    IMAGE_COUNT: 5,
    IMAGE_SIZE_PX: 15,
  },
};
let CURRENT_CONFIG = "circuit";
let QUEUE_CONFIG = "";
let LAST_CHANGED = Date.now();
const DIMX = IS_MOBILE ? 40 : 200;
const DIMY = IS_MOBILE ? 80 : 100;
const TILES_PER_FRAME = IS_MOBILE ? 10 : 500;
const CANVAS_WIDTH = IS_MOBILE ? 1000 : 1300;
const CANVAS_HEIGHT = IS_MOBILE ? 2000 : 650;
const SHOW_VALID_COUNT = false;
const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;
const LOGGING = false;
const WRAP_AROUND = false;
const MOUSE_DEBUG = true;
let running = true;
let tileWidth;
let tileHeight;

let tiles = [];
let tilesCopy = [];
let tileSubset = [];
let tileRules = [];
let eventStack = [];

function preload() {
  let imageSets = Object.keys(settings);
  for (let j = 0; j < imageSets.length; j++) {
    tileImages[imageSets[j]] = [];
    for (let i = 0; i <= settings[imageSets[j]].IMAGE_COUNT; i++) {
      tileImages[imageSets[j]].push(
        loadImage(`wavefunctioncollapse/${imageSets[j]}/${i}.png`)
      );
    }
  }
}

function setup() {
  createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  noSmooth();
  setupRules();
}

function draw() {
  for (let f = 0; f < TILES_PER_FRAME; f++) {
    update();
  }
}

function setupRules() {
  background(100);
  tileRules = [];
  tiles = [];
  eventStack = [];
  allValid = true;
  valid = [];
  running = true;
  for (let i = 0; i <= settings[CURRENT_CONFIG].IMAGE_COUNT; i++) {
    tileRules[i] = new TileRule(i);
  }
  switch (CURRENT_CONFIG) {
    case "circuit": {
      tileRules[6].probability = 4;
      tileRules[7].probability = 10;
      tileRules[7].edgeOnly = [7];
      tileRules[6].removeNeighbors = [6];
      tileRules[9].removeNeighbors = [9];
      break;
    }

    case "coast": {
      tileRules[2].edgeOnly = [2, 7];
      tileRules[7].edgeOnly = [2, 7];
      tileRules[5].removeNeighbors = [5, 6, 8];
      tileRules[6].removeNeighbors = [5, 6, 8];
      tileRules[8].removeNeighbors = [5, 6, 8];
      tileRules[3].removeNeighbors = [3];
      tileRules[4].removeNeighbors = [4];
      tileRules[0].probability = 100;
      tileRules[1].probability = 100;
      tileRules[2].probability = 10;
      tileRules[7].probability = 10;
      //tileRules[3].probability = 3;
      //tileRules[4].probability = 3;
      break;
    }
  }

  for (let i = 0; i < tileImages[CURRENT_CONFIG].length; i++) {
    for (let j = 1; j <= 3; j++) {
      switch (CURRENT_CONFIG) {
        case "coast": {
          switch (tileRules[i].image_idx) {
            case 2: {
              break;
            }
            case 7: {
              if (j != 2) {
                tileRules.push(tileRules[i].rotate(j));
              }
              break;
            }
            default: {
              tileRules.push(tileRules[i].rotate(j));
              break;
            }
          }
          break;
        }
        default: {
          tileRules.push(tileRules[i].rotate(j));
          break;
        }
      }
    }
  }
  for (let i = 0; i < tileRules.length; i++) {
    if (tileRules[i] != null) {
      tileRules[i].calculateAdjacency();
    }
  }
  let fill = 1 + 1 / settings[CURRENT_CONFIG].IMAGE_SIZE_PX;
  tileWidth = (width * fill) / DIMX;
  tileHeight = (height * fill) / DIMY;
  for (let j = 0; j < DIMY; j++) {
    for (let i = 0; i < DIMX; i++) {
      tiles.push(new Tile(i, j));
    }
  }
  tilesCopy = [tiles[0]];
  console.log(tileImages);
  console.log(tiles);
  console.log(tileRules);
}

function mousePressed() {
  let timeSinceLast = Date.now() - LAST_CHANGED;
  if (timeSinceLast > 1000 * 2) {
    LAST_CHANGED = Date.now();
    let configs = Object.keys(settings);
    let currIdx = 0;
    for (let i = 0; i < configs.length; i++) {
      if (configs[i] == CURRENT_CONFIG) {
        currIdx = i;
      }
    }
    let nextIdx = (currIdx + 1) % configs.length;
    QUEUE_CONFIG = configs[nextIdx];
  }
}

function probabilityBucket(validTiles) {
  let bucket = [];
  for (let i = 0; i < validTiles.length; i++) {
    for (let j = 0; j < tileRules[validTiles[i]].probability; j++) {
      bucket.push(validTiles[i]);
    }
  }
  return bucket;
}

let valid = [];
let allValid = true;
function update() {
  if (QUEUE_CONFIG != "") {
    CURRENT_CONFIG = QUEUE_CONFIG;
    QUEUE_CONFIG = "";
    setupRules();
  }
  if (running) {
    if (allValid) {
      if (tilesCopy.length == 0) {
        running = false;
      }
      // Pick a random tile to collapse
      tilesCopy = tilesCopy.filter((element) => {
        return element.validTiles.length > 1 || element.collapsed == false;
      });
      let minCount = Infinity;
      for (let i = 0; i < tilesCopy.length; i++) {
        if (tilesCopy[i].validTiles.length < minCount) {
          minCount = tilesCopy[i].validTiles.length;
        }
      }
      let tempTilesCopy = tilesCopy.filter((element) => {
        return element.validTiles.length <= minCount + 2;
      });
      if (tempTilesCopy.length > 0) {
        // Backtracking has been having alot of problems
        // because of two paths being evaluated at the same time
        // making edge generation fail over and over
        // We should prioritise the tiles that are closest to the last edge that was generated
        let last = eventStack[eventStack.length - 1];
        if (last != null) {
          tempTilesCopy = tempTilesCopy.sort((a, b) => {
            let distA = Math.abs(last.i - a.i) + Math.abs(last.j - a.j);
            let distB = Math.abs(last.i - b.i) + Math.abs(last.j - b.j);
            return distA - distB;
          });
        }
        let tile = random(tempTilesCopy.slice(0, 2));
        let selectedTile = random(probabilityBucket(tile.validTiles));
        if (selectedTile != null) {
          tile.validTiles = [selectedTile];
          tile.collapsed = true;
          tile.draw();
          eventStack.push({
            i: tile.i,
            j: tile.j,
            selected: selectedTile,
          });
          if (LOGGING)
            console.log(
              `Pushed: ${JSON.stringify(eventStack[eventStack.length - 1])}`
            );
        } else {
          tile.validTiles = [];
        }
        valid = [
          checkNeighbors(tile.i, tile.j, false),
          checkNeighbors(tile.i, tile.j - 1),
          checkNeighbors(tile.i, tile.j + 1),
          checkNeighbors(tile.i - 1, tile.j),
          checkNeighbors(tile.i + 1, tile.j),
        ];
        allValid = true;
        for (let i = 0; i < valid.length; i++) {
          if (valid[i] == false) {
            allValid = false;
          }
        }
      }
    } else {
      // Revert previous changes
      event = eventStack.pop();
      if (LOGGING) console.log(`Reversed: ${JSON.stringify(event)}`);
      let lastTile = tiles[event.j * DIMX + event.i];
      lastTile.collapsed = false;
      lastTile.draw();
      tilesCopy.push(lastTile);
      let alreadyAdded = false;
      for (let i = 0; i < lastTile.backtrackInvalid.length; i++) {
        if (lastTile.backtrackInvalid[i] == event.selected) {
          alreadyAdded = true;
        }
      }
      if (!alreadyAdded) lastTile.backtrackInvalid.push(event.selected);
      valid = [
        checkNeighbors(event.i, event.j, false),
        checkNeighbors(event.i, event.j - 1),
        checkNeighbors(event.i, event.j + 1),
        checkNeighbors(event.i - 1, event.j),
        checkNeighbors(event.i + 1, event.j),
      ];
      allValid = true;
      for (let i = 0; i < valid.length; i++) {
        if (valid[i] == false) {
          allValid = false;
        }
      }
    }
  }
}
