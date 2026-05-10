function generateTrafficData() {
  return {
    north: Math.floor(Math.random() * 71) + 10,
    south: Math.floor(Math.random() * 51) + 10,
    east: Math.floor(Math.random() * 61) + 10,
    west: Math.floor(Math.random() * 41) + 10,
  };
}

module.exports = generateTrafficData;