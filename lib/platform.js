/* eslint-disable no-console */
const semver = require('semver');
const castArray = require('lodash.castarray');

const { Client } = require('./client');
const { WizAccessory } = require('./wiz-accessory');
const { lookup } = require('./utils');

const packageConfig = require('../package.json');

/**
 * @private
 */
const configSetup = function configSetup() {
  const c = this.config;
  c.addCustomCharacteristics =
    c.addCustomCharacteristics == null ? true : c.addCustomCharacteristics;
  c.deviceTypes = c.deviceTypes == null ? [] : castArray(c.deviceTypes);

  c.discoveryOptions = c.discoveryOptions || {};
  const dis = c.discoveryOptions;
  dis.broadcast = dis.broadcast || c.broadcast;
  dis.discoveryInterval =
    dis.discoveryInterval || c.pollingInterval * 1000 || 10000;
  dis.deviceTypes = dis.deviceTypes || c.deviceTypes;
  dis.deviceOptions = dis.deviceOptions || c.deviceOptions || {};
  dis.macAddresses = dis.macAddresses || c.macAddresses || [];
  dis.excludeMacAddresses =
    dis.excludeMacAddresses || c.excludeMacAddresses || [];
  if (Array.isArray(c.devices)) {
    dis.devices = c.devices;
  }

  c.defaultSendOptions = c.defaultSendOptions || {};
  const dso = c.defaultSendOptions;
  dso.timeout = dso.timeout || c.timeout * 1000 || 15000;

  const dev = dis.deviceOptions;
  dev.defaultSendOptions = dev.defaultSendOptions || { ...dso };
  dev.inUseThreshold = dev.inUseThreshold || c.inUseThreshold;
};

/**
 * @private
 */
const createWizAccessory = function createWizAccessory(
  platform,
  accessory,
  wizDevice
) {
  const { Categories } = platform.homebridge.hap.Accessory;
  const { Service } = platform.homebridge.hap;

  const [category, services] = (() => {
    if (wizDevice.deviceType === 'bulb') {
      return [Categories.LIGHTBULB, [Service.Lightbulb]];
    }
    /**
     * TODO: Support other things
     */
    platform.log.warn('Found an unsupported device, ignoring:');
    platform.log.warn(wizDevice);
  })();

  return new WizAccessory(
    platform,
    platform.config,
    accessory,
    wizDevice,
    category,
    services
  );
};

class WizSmarthomePlatform {
  constructor(log, config, homebridge) {
    this.log = log;
    this.config = config || {};
    this.homebridge = homebridge;

    this.log.info(
      '%s v%s, node %s, homebridge v%s',
      packageConfig.name,
      packageConfig.version,
      process.version,
      homebridge.serverVersion
    );
    if (!semver.satisfies(process.version, packageConfig.engines.node)) {
      this.log.error(
        'Error: not using minimum node version %s',
        packageConfig.engines.node
      );
    }
    this.log.debug('config.json: %j', config);

    configSetup.call(this);
    this.log.debug('config: %j', this.config);

    this.homebridgeAccessories = new Map();
    this.deviceAccessories = new Map();

    const WizSmarthomeLog = {
      ...this.log,
      prefix: `${this.log.prefix || 'WizSmarthome'}.API`,
    };

    this.client = new Client({
      logger: WizSmarthomeLog,
      defaultSendOptions: this.config.defaultSendOptions,
    });

    this.client.on('device-new', device => {
      this.log.info(
        'New Device Online: [%s] %s [%s]',
        device.alias,
        device.deviceType,
        device.id,
        device.host,
        device.port
      );
      this.addAccessory(device);
    });

    this.client.on('device-online', device => {
      this.log.debug(
        'Device Online: [%s] %s [%s]',
        device.alias,
        device.deviceType,
        device.id,
        device.host,
        device.port
      );
      this.addAccessory(device);
    });

    this.client.on('device-offline', device => {
      const deviceAccessory = this.deviceAccessories.get(device.id);
      if (deviceAccessory !== undefined) {
        this.log.debug(
          'Device Offline: [%s] %s [%s]',
          deviceAccessory.homebridgeAccessory.displayName,
          device.deviceType,
          device.id,
          device.host,
          device.port
        );
      }
    });

    this.homebridge.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      this.client.startDiscovery({
        ...this.config.discoveryOptions,
        filterCallback: si => {
          return si.deviceId != null && si.deviceId.length > 0;
        },
      });
    });

    this.homebridge.on('shutdown', () => {
      this.log.debug('shutdown');
      this.client.stopDiscovery();
    });

    this.getCategoryName = lookup.bind(
      homebridge.hap.Accessory.Categories,
      null
    );
    this.getServiceName = lookup.bind(
      homebridge.hap.Service,
      (thisKeyValue, value) => thisKeyValue.UUID === value.UUID
    );

    this.getCharacteristicName = characteristic => {
      return (
        characteristic.name ||
        characteristic.displayName ||
        lookup.bind(
          homebridge.hap.Characteristic,
          (thisKeyValue, value) => thisKeyValue.UUID === value.UUID
        )(characteristic)
      );
    };
  }

  registerPlatformAccessory(platformAccessory) {
    this.log.debug(
      'registerPlatformAccessory(%s)',
      platformAccessory.displayName
    );
    this.homebridge.registerPlatformAccessories(
      'homebridge-wiz-smarthome',
      'WizSmarthome',
      [platformAccessory]
    );
  }

  // Function invoked when homebridge tries to restore cached accessory
  configureAccessory(accessory) {
    this.log.info(
      'Configuring cached accessory: [%s] %s %s',
      accessory.displayName,
      accessory.context.deviceId,
      accessory.UUID
    );
    this.log.debug('%j', accessory);
    this.homebridgeAccessories.set(accessory.UUID, accessory);
  }

  addAccessory(device) {
    const deviceId = device.id;

    if (deviceId == null || deviceId.length === 0) {
      this.log.error('Missing deviceId: %s', device.host);
      return;
    }

    let deviceAccessory = this.deviceAccessories.get(deviceId);

    if (deviceAccessory) {
      return;
    }

    this.log.info(
      'Adding: [%s] %s [%s]',
      device.alias,
      device.deviceType,
      deviceId
    );

    const uuid = this.homebridge.hap.uuid.generate(deviceId);
    const homebridgeAccessory = this.homebridgeAccessories.get(uuid);

    deviceAccessory = createWizAccessory(this, homebridgeAccessory, device);

    this.deviceAccessories.set(deviceId, deviceAccessory);
    this.homebridgeAccessories.set(uuid, deviceAccessory.homebridgeAccessory);
  }

  removeAccessory(homebridgeAccessory) {
    this.log.info('Removing: %s', homebridgeAccessory.displayName);

    this.deviceAccessories.delete(homebridgeAccessory.context.deviceId);
    this.homebridgeAccessories.delete(homebridgeAccessory.UUID);
    this.homebridge.unregisterPlatformAccessories(
      'homebridge-wiz-smarthome',
      'WizSmarthome',
      [homebridgeAccessory]
    );
  }
}

module.exports = WizSmarthomePlatform;
