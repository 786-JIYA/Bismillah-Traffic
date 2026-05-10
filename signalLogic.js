function calculateGreenTime(vehicleCount) {

  const baseTime = 15;
  const k = 0.8;

  let greenTime = baseTime + (k * vehicleCount);

  // Minimum green time
  if (greenTime < 10) {
    greenTime = 10;
  }

  // Maximum cap
  if (greenTime > 90) {
    greenTime = 90;
  }

  return Math.round(greenTime);
}

module.exports = calculateGreenTime;