'use strict';

/* CommonJS keeps this regression harness outside the TypeScript production build. */

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class MockDevice {}

const originalLoad = Module._load;
Module._load = function loadWithHomeyMock(request, parent, isMain) {
  if (request === 'homey') {
    return { Device: MockDevice };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Senso4sDevice = require('../.homeybuild/drivers/senso4s/device.js');
Module._load = originalLoad;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDevice() {
  const device = new Senso4sDevice();
  const timers = [];
  const logs = [];
  const errors = [];
  const capabilityUpdates = [];

  device.homey = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    setInterval(callback, delay) {
      return { callback, delay, cleared: false };
    },
    clearInterval(timer) {
      timer.cleared = true;
    },
  };
  device.log = (...args) => logs.push(args);
  device.error = (...args) => errors.push(args);
  device.setCapabilityValueIfChanged = async (capability, value) => {
    capabilityUpdates.push({ capability, value });
  };

  return {
    device,
    timers,
    logs,
    errors,
    capabilityUpdates,
    async fireTimer(delay) {
      let timer = null;
      for (let attempt = 0; attempt < 10 && !timer; attempt += 1) {
        timer = timers.find((candidate) => !candidate.cleared && candidate.delay === delay);
        if (!timer) {
          await flush();
        }
      }
      assert.ok(timer, `Expected an active ${delay} ms timer`);
      timer.cleared = true;
      timer.callback();
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('coalesces concurrent active BLE reads into one operation', async () => {
  const { device } = createDevice();
  const activeRead = deferred();
  let performCalls = 0;

  device.performActiveRead = async () => {
    performCalls += 1;
    await activeRead.promise;
  };

  const first = device.updateFromConnection();
  const second = device.updateFromConnection();
  assert.equal(performCalls, 1);

  activeRead.resolve();
  await Promise.all([first, second]);

  assert.equal(performCalls, 1);
  assert.equal(device.activeReadOperation, null);
});

test('active-read deadline releases ownership even when disconnect never settles', async () => {
  const {
    device,
    capabilityUpdates,
    fireTimer,
  } = createDevice();
  let disconnectCalls = 0;

  device.performActiveRead = async (attemptId) => {
    device.activePeripheral = {
      attemptId,
      peripheral: {
        disconnect() {
          disconnectCalls += 1;
          return new Promise(() => undefined);
        },
      },
    };
    await new Promise(() => undefined);
  };

  const update = device.updateFromConnection();
  await fireTimer(45_000);
  await flush();
  await fireTimer(5_000);
  await update;

  assert.equal(disconnectCalls, 1);
  assert.equal(device.activePeripheral, null);
  assert.equal(device.activeReadOperation, null);
  assert.deepEqual(capabilityUpdates.at(-1), {
    capability: 'alarm_connectivity',
    value: true,
  });
});

test('disconnects a peripheral that arrives after its active-read deadline', async () => {
  const { device, fireTimer } = createDevice();
  const connection = deferred();
  let disconnectCalls = 0;

  device.findAdvertisement = async () => ({
    uuid: 'late-peripheral',
    address: 'AA:BB:CC:DD:EE:FF',
    rssi: -50,
    connect: () => connection.promise,
  });
  device.setUpdateMethod = async () => undefined;

  const update = device.updateFromConnection();
  await flush();
  await fireTimer(45_000);
  await update;

  connection.resolve({
    disconnect: async () => {
      disconnectCalls += 1;
    },
  });
  await flush();
  await flush();

  assert.equal(disconnectCalls, 1);
  assert.equal(device.activePeripheral, null);
});

test('level-notification cleanup cannot block the active read forever', async () => {
  const { device, fireTimer } = createDevice();
  let unsubscribeCalls = 0;
  const characteristic = {
    subscribeToNotifications: async () => undefined,
    unsubscribeFromNotifications() {
      unsubscribeCalls += 1;
      return new Promise(() => undefined);
    },
  };
  const peripheral = {
    read: async () => {
      throw new Error('direct read unavailable');
    },
    getService: async () => ({
      getCharacteristic: async () => characteristic,
    }),
  };

  const read = device.readLevelByte(peripheral);
  await flush();
  await fireTimer(5_000);
  await flush();
  await fireTimer(5_000);

  assert.equal(await read, null);
  assert.equal(unsubscribeCalls, 1);
});

test('shutdown cancels and awaits the active read while disconnecting once', async () => {
  const { device } = createDevice();
  let disconnectCalls = 0;

  device.performActiveRead = async (attemptId) => {
    device.activePeripheral = {
      attemptId,
      peripheral: {
        disconnect: async () => {
          disconnectCalls += 1;
        },
      },
    };
    await new Promise(() => undefined);
  };

  const update = device.updateFromConnection();
  await flush();
  await device.shutdownBleLifecycle('test shutdown');
  await update;

  assert.equal(disconnectCalls, 1);
  assert.equal(device.shuttingDown, true);
  assert.equal(device.activePeripheral, null);
  assert.equal(device.activeReadOperation, null);
});

test('initialization cannot restart timers after concurrent shutdown', async () => {
  const { device } = createDevice();
  const activeRead = deferred();
  let startTimerCalls = 0;

  device.getData = () => ({ id: 'senso4s' });
  device.getStore = () => ({});
  device.ensureCapabilities = async () => undefined;
  device.removeDeprecatedCapabilities = async () => undefined;
  device.loadSettings = () => undefined;
  device.startAdvertisementSubscription = async () => undefined;
  device.updateFromAdvertisement = async () => undefined;
  device.updateFromConnection = async () => activeRead.promise;
  device.startTimers = () => {
    startTimerCalls += 1;
  };

  const initialization = device.onInit();
  await flush();
  await device.shutdownBleLifecycle('test shutdown during initialization');
  activeRead.resolve();
  await initialization;

  assert.equal(startTimerCalls, 0);
  assert.equal(device.shuttingDown, true);
});

test('late advertisement subscription is boundedly removed after shutdown', async () => {
  const { device, fireTimer } = createDevice();
  const subscription = deferred();
  let unsubscribeCalls = 0;

  device.homey.hasFeature = () => true;
  device.homey.ble = {
    subscribeToAdvertisements: () => subscription.promise,
  };

  const start = device.startAdvertisementSubscription();
  await device.shutdownBleLifecycle('test shutdown before subscription resolves');
  subscription.resolve(() => {
    unsubscribeCalls += 1;
    return new Promise(() => undefined);
  });
  await flush();
  await fireTimer(5_000);
  await start;

  assert.equal(unsubscribeCalls, 1);
  assert.equal(device.unsubscribeAdvertisements, null);
});
