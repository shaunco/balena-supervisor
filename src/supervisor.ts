import APIBinder from './api-binder';
import * as db from './db';
import * as config from './config';
import DeviceState from './device-state';
import * as eventTracker from './event-tracker';
import { intialiseContractRequirements } from './lib/contracts';
import { normaliseLegacyDatabase } from './lib/migration';
import * as osRelease from './lib/os-release';
import Logger from './logger';
import SupervisorAPI from './supervisor-api';

import constants = require('./lib/constants');
import log from './lib/supervisor-console';
import version = require('./lib/supervisor-version');

const startupConfigFields: config.ConfigKey[] = [
	'uuid',
	'listenPort',
	'apiEndpoint',
	'apiSecret',
	'apiTimeout',
	'unmanaged',
	'deviceApiKey',
	'mixpanelToken',
	'mixpanelHost',
	'loggingEnabled',
	'localMode',
	'legacyAppsPresent',
];

export class Supervisor {
	private logger: Logger;
	private deviceState: DeviceState;
	private apiBinder: APIBinder;
	private api: SupervisorAPI;

	public constructor() {
		this.logger = new Logger();
		this.apiBinder = new APIBinder({
			logger: this.logger,
		});
		this.deviceState = new DeviceState({
			logger: this.logger,
			apiBinder: this.apiBinder,
		});
		// workaround the circular dependency
		this.apiBinder.setDeviceState(this.deviceState);

		// FIXME: rearchitect proxyvisor to avoid this circular dependency
		// by storing current state and having the APIBinder query and report it / provision devices
		this.deviceState.applications.proxyvisor.bindToAPI(this.apiBinder);

		this.api = new SupervisorAPI({
			routers: [this.apiBinder.router, this.deviceState.router],
			healthchecks: [
				this.apiBinder.healthcheck.bind(this.apiBinder),
				this.deviceState.healthcheck.bind(this.deviceState),
			],
		});
	}

	public async init() {
		log.info(`Supervisor v${version} starting up...`);

		await db.initialized;
		await config.initialized;
		await eventTracker.initialized;

		const conf = await config.getMany(startupConfigFields);

		log.debug('Starting logging infrastructure');
		this.logger.init({
			enableLogs: conf.loggingEnabled,
			...conf,
		});

		intialiseContractRequirements({
			supervisorVersion: version,
			deviceType: await config.get('deviceType'),
			l4tVersion: await osRelease.getL4tVersion(),
		});

		log.debug('Starting api binder');
		await this.apiBinder.initClient();

		this.logger.logSystemMessage('Supervisor starting', {}, 'Supervisor start');
		if (conf.legacyAppsPresent && this.apiBinder.balenaApi != null) {
			log.info('Legacy app detected, running migration');
			await normaliseLegacyDatabase(
				this.deviceState.applications,
				this.apiBinder.balenaApi,
			);
		}

		await this.deviceState.init();

		log.info('Starting API server');
		this.api.listen(
			constants.allowedInterfaces,
			conf.listenPort,
			conf.apiTimeout,
		);
		this.deviceState.on('shutdown', () => this.api.stop());

		await this.apiBinder.start();
	}
}

export default Supervisor;
