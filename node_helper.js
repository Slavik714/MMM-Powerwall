/* Magic Mirror
 * Node Helper: MMM-Powerwall
 *
 * By Mike Bishop
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const fs = require("fs").promises;
const fetch = require("node-fetch");
const auth = require("./tesla-oauth-v3.js");
const powerwall = require("./powerwall");
const path = require("path");
const nunjucks = require("./../../vendor/node_modules/nunjucks");
const { check, validationResult, matchedData } = require('express-validator');
const bodyParser = require('./../../node_modules/body-parser');


module.exports = NodeHelper.create({

	start: async function() {
		this.twcStatus = {};
		this.twcVINs = {};
		this.chargeHistory = {};
		this.teslaApiAccounts = {};
		this.powerwallAccounts = {};
		this.energy = {};
		this.backup = {};
		this.selfConsumption = {};
		this.storm = {};
		this.vehicles = {};
		this.vehicleData = {};
		this.powerHistory = {};
		this.filenames = [];
		this.lastUpdate = 0;
		this.debug = false;
		this.thisConfigs = [];
		this.tokenFile = path.resolve(__dirname + "/tokens.json");
		this.localPwFile = path.resolve(__dirname + "/localpw.json");
		this.template =	null;

		await this.loadTranslation("en");
		await this.combineConfig();
		await this.configureAccounts();
		await this.createAuthPage();
	},

	createAuthPage: async function() {
		this.expressApp.get("/MMM-Powerwall/auth", (req,res) => {
			res.send(
				nunjucks.render(__dirname + "/auth.njk", {
					translations: this.translation,
					errors: {},
					data: {},
					configUsers: Object.keys(this.teslaApiAccounts),
					configIPs: Object.keys(this.powerwallAccounts),
				})
			);
		});

		this.expressApp.use(bodyParser.urlencoded({ extended: false }));
		this.expressApp.post("/MMM-Powerwall/auth", [
			check("username")
				.isEmail()
				.withMessage(this.translation.needusername)
				.trim(),
			check("password")
				.notEmpty()
				.withMessage(this.translation.needpassword)
				.trim(),
			check("mfa")
				.optional( {
					checkFalsy: true
				})
				.isNumeric( {no_symbols: true })
				.withMessage(this.translation.invalidmfa)
		], async (req,res) => {
			var errors = validationResult(req).mapped();

			if (Object.keys(errors).length == 0) {
				var authenticator = new auth.Authenticator();

				authenticator.on('error', (message) => {
					if( message == "invalid credentials") {
						errors.password = {
							value: "",
							msg: this.translation.invalidpassword,
							param: "password",
							location: "body"
						};
					}
					else {
						errors.general = {
							value: "",
							msg: message,
							param: null,
							location: "body"
						}
					}
				});
				authenticator.on('ready', async (credentials) => {
					this.log("Got Tesla API tokens")
					this.teslaApiAccounts[req.body["username"]] = credentials.ownerApi;
					this.teslaApiAccounts[req.body["username"]].refresh_token = credentials.auth.refresh_token;
					await fs.writeFile(this.tokenFile, JSON.stringify(this.teslaApiAccounts));
				});
				authenticator.on('mfa', () => {
					let message;
					if( req.body["mfa"].length == 0 ) {
						message = this.translation.needmfa;
					}
					else {
						message = this.translation.invalidmfa;
					}

					errors.mfa = {
						value: "",
						msg: message,
						param: "mfa",
						location: "body"
					}
				});

				await authenticator.login(
					req.body["username"],
					req.body["password"],
					req.body["mfa"]
				);

				if (Object.keys(errors).length == 0) {
					return res.redirect("../..");
				}
			}
			return res.send(
				nunjucks.render(__dirname + "/auth.njk", {
					translations: this.translation,
					errors: errors,
					data: req.body,
					configUsers: Object.keys(this.teslaApiAccounts),
					configIPs: Object.keys(this.powerwallAccounts),
				})
			);
		});

		this.expressApp.post("/MMM-Powerwall/authLocal", [
			check("password")
				.notEmpty()
				.withMessage(this.translation.needpassword)
				.trim()
		], async (req,res) => {
			var errors = validationResult(req).mapped();

			if (Object.keys(errors).length == 0) {
				let thisPowerwall = this.powerwallAccounts[req.body["ip"]];
				thisPowerwall.
					once("error", message => {
						errors.password = {
							value: "",
							msg: message,
							param: "password",
							location: "body"
						};
					}).
					once("login", async () => {
						let fileContents = {};
						try {
							fileContents = JSON.parse(
									await fs.readFile(this.localPwFile)
							);
						}
						catch {}
						fileContents[req.body["ip"]] = req.body["password"];
						try {
							await fs.writeFile(this.localPwFile, JSON.stringify(fileContents));
						}
						catch {}
					});
				await thisPowerwall.login(req.body["password"]);
			}
			if (Object.keys(errors).length == 0) {
				return res.redirect("../..");
			}
			return res.send(
				nunjucks.render(__dirname + "/auth.njk", {
					translations: this.translation,
					errors: errors,
					data: req.body,
					configUsers: Object.keys(this.teslaApiAccounts),
					configIPs: Object.keys(this.powerwallAccounts),
				})
			);
		});

	},

	combineConfig: async function() {
		// function copied from MichMich (MIT)
		var defaults = require(__dirname + "/../../js/defaults.js");
		var configFilename = path.resolve(__dirname + "/../../config/config.js");
		if (typeof(global.configuration_file) !== "undefined") {
			configFilename = global.configuration_file;
		}

		try {
			var c = require(configFilename);
			var config = Object.assign({}, defaults, c);
			this.configOnHd = config;
			// Get the configuration for this module.
			if ("modules" in this.configOnHd) {
				this.thisConfigs = this.configOnHd.modules.
					filter(m => "config" in m && "module" in m && m.module === 'MMM-Powerwall').
					map(m => m.config);
			}
		} catch (e) {
			console.error("MMM-Powerwall WARNING! Could not load config file. Starting with default configuration. Error found: " + e);
			this.configOnHd = defaults;
		}

		this.debug = this.thisConfigs.some(config => config.debug);
		this.loadTranslation(this.configOnHd.language);
	},

	loadTranslation: async function(language) {
		var self = this;

		try {
			self.translation = Object.assign({}, self.translation, JSON.parse(
				await fs.readFile(
					path.resolve(__dirname + "/translations/" + language + ".json")
				)
			));
		}
		catch {}
	},

	configureAccounts: async function() {
		let fileContents = {};
		try {
			fileContents = JSON.parse(
					await fs.readFile(this.tokenFile)
			);
		}
		catch(e) {
		}

		await new Promise(resolve => setTimeout(resolve, 10000));

		if( Object.keys(fileContents).length >= 1 ) {
			this.log("Read Tesla API tokens from file");

			this.teslaApiAccounts = {
				...this.teslaApiAccounts,
				...fileContents
			};

			this.log(JSON.stringify(this.teslaApiAccounts));
		}
		else {
			this.log("Token file is empty");
		}

		let self = this;
		this.thisConfigs.forEach(async config => {
			let username = config.teslaAPIUsername;
			let password = config.teslaAPIPassword;

			if( !this.teslaApiAccounts[username] ) {
				this.teslaApiAccounts[username] = null;
				if( password ) {
					await this.doTeslaApiLogin(username, password);
				}
				else {
					this.log("Missing both Tesla password and access tokens for " + username);
				}
			}
		});

		await self.doTeslaApiTokenUpdate();

		for (const username in this.teslaApiAccounts) {
			if( this.checkTeslaCredentials(username) ) {
				if( !this.vehicles[username]) {
					// See if there are any cars on the account.
					this.vehicles[username] = await this.doTeslaApiGetVehicleList(username);
				}
			}
		}

		// Now do Powerwalls
		try {
			fileContents = JSON.parse(
					await fs.readFile(this.localPwFile)
			);
		}
		catch(e) {
			fileContents = {};
		}

		let changed = false;
		for( const config of this.thisConfigs ) {
			let powerwallIP = config.powerwallIP;
			let powerwallPassword = config.powerwallPassword || fileContents[powerwallIP];

			let thisPowerwall = this.powerwallAccounts[powerwallIP];
			if( !thisPowerwall ) {
				thisPowerwall = new powerwall.Powerwall(powerwallIP);
				thisPowerwall.
					on("error", error => {
						self.log(powerwallIP + " error: " + error);
						if( !thisPowerwall.authenticated ) {
							self.sendSocketNotification("ReconfigurePowerwall", {
								ip: powerwallIP,
							});
						}
					}).
					on("login", () => {
						this.log("Successfully logged into " + powerwallIP);
						self.sendSocketNotification("PowerwallConfigured", {
							ip: powerwallIP,
						});
					}).
					on("aggregates", aggregates => {
						self.sendSocketNotification("Aggregates", {
							ip: powerwallIP,
							aggregates: aggregates
						});
					}).
					on("soe", soe => {
						self.sendSocketNotification("SOE", {
							ip: powerwallIP,
							soe: soe
						});
					}).
					on("grid", grid => {
						self.sendSocketNotification("GridStatus", {
							ip: powerwallIP,
							gridStatus: grid
						});
					})
				this.powerwallAccounts[powerwallIP] = thisPowerwall;
			}

			if( !thisPowerwall.authenticated ) {
				if( powerwallPassword ) {
					await thisPowerwall.login(powerwallPassword);
					if( thisPowerwall.authenticated && fileContents[powerwallIP] != powerwallPassword ) {
						fileContents[powerwallIP] = powerwallPassword;
						changed = true;
					}
				}
				else {
					self.sendSocketNotification("ReconfigurePowerwall", {
						ip: powerwallIP,
					});
				}
			}
		}

		if( changed ) {
			try {
				await fs.writeFile(this.localPwFile, JSON.stringify(fileContents));
			}
			catch (e) {}
		}
	},

	// Override socketNotificationReceived method.

	/* socketNotificationReceived(notification, payload)
	 * This method is called when a socket notification arrives.
	 *
	 * argument notification string - The identifier of the noitication.
	 * argument payload mixed - The payload of the notification.
	 */
	socketNotificationReceived: async function(notification, payload) {
		const self = this;

		this.log(notification + JSON.stringify(payload));

		if (notification === "Configure-TeslaAPI") {
			let username = payload.teslaAPIUsername;
			let siteID = payload.siteID;
			await this.configureAccounts();

			if( username && this.checkTeslaCredentials(username) ) {
				if( !siteID ) {
					this.log("Attempting to infer siteID");
					siteID = await this.inferSiteID(username);
					this.log("Found siteID " + siteID);
				}

				this.sendSocketNotification("TeslaAPIConfigured", {
					username: username,
					siteID: siteID,
					vehicles: this.vehicles[username]
				});

			}
		}
		else if (notification === "UpdateLocal") {
			let ip = payload.powerwallIP;
			if( ip in this.powerwallAccounts ) {
				let pwPromise = this.powerwallAccounts[ip].update(payload.updateInterval);

				ip = payload.twcManagerIP;
				let port = payload.twcManagerPort;
				if( ip ) {
					this.initializeCache(this.twcStatus, ip);
					this.initializeCache(this.twcVINs, ip);
					if( this.twcStatus[ip].lastUpdate + (payload.updateInterval || 0) < Date.now() ) {
						await self.updateTWCManager(ip, port);
					}
					else {
						this.sendSocketNotification("ChargeStatus", {
							ip: ip,
							status: this.twcStatus[ip].lastResult,
							vins: this.twcVINs[ip].lastResult
						});
					}
				}
				await pwPromise;
			}
		}
		else if (notification === "UpdateStormWatch") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.storm, username, siteID);
			}
			else {
				return;
			}

			if( this.storm[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetStormWatch(username, siteID);
			}
			else {
				this.sendSocketNotification("StormWatch", {
					username: username,
					siteID: siteID,
					storm: this.storm[username][siteID].lastResult.storm_mode_active
				});
			}
		}
		else if (notification === "UpdateEnergy") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.energy, username, siteID);
			}
			else {
				return;
			}

			if( this.energy[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetEnergy(username, siteID);
			}
			else {
				this.sendSocketNotification("EnergyData", {
					username: username,
					siteID: siteID,
					energy: this.energy[username][siteID].lastResult
				});
			}
		}
		else if (notification === "UpdateSelfConsumption") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.selfConsumption, username, siteID);
			}
			else {
				return;
			}

			if( this.selfConsumption[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetSelfConsumption(username, siteID);
			}
			else {
				this.sendSocketNotification("SelfConsumption", {
					username: username,
					siteID: siteID,
					selfConsumption: this.selfConsumption[username][siteID].lastResult
				});
			}
		}
		else if (notification === "UpdatePowerHistory") {
			let username = payload.username;
			let siteID = payload.siteID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( siteID ) {
				this.initializeCache(this.powerHistory, username, siteID);
				this.initializeCache(this.backup, username, siteID);
			}
			else {
				return;
			}

			if( this.powerHistory[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetPowerHistory(username, siteID);
			}
			else {
				this.sendSocketNotification("PowerHistory", {
					username: username,
					siteID: siteID,
					powerHistory: this.powerHistory[username][siteID].lastResult
				});
			}
			if( this.backup[username][siteID].lastUpdate + payload.updateInterval < Date.now()) {
				await self.doTeslaApiGetBackupHistory(username, siteID);
			}
			else {
				this.sendSocketNotification("Backup", {
					username: username,
					siteID: siteID,
					backup: this.backup[username][siteID].lastResult
				});
			}

		}
		else if (notification === "UpdateChargeHistory") {
			let twcManagerIP = payload.twcManagerIP;
			let twcManagerPort = payload.twcManagerPort;

			this.initializeCache(this.chargeHistory, twcManagerIP);

			if( this.chargeHistory[twcManagerIP].lastUpdate + payload.updateInterval < Date.now()) {
				await self.updateTWCHistory(twcManagerIP, twcManagerPort);
			}
			else {
				this.sendSocketNotification("ChargeHistory", {
					twcManagerIP: twcManagerIP,
					chargeHistory: this.chargeHistory[twcManagerIP].lastResult
				});
			}
		}
		else if (notification === "UpdateVehicleData") {
			let username = payload.username;
			let vehicleID = payload.vehicleID;

			if( username && !this.checkTeslaCredentials(username) ) {
				return;
			}

			if( vehicleID ) {
				this.initializeCache(this.vehicleData, username, vehicleID);
			}
			else {
				return;
			}

			let useCache = !(this.vehicleData[username][vehicleID].lastUpdate + payload.updateInterval
				<= Date.now() );
			this.doTeslaApiGetVehicleData(username, vehicleID, useCache);
		}
	},

	checkTeslaCredentials: function(username) {
		if( !this.teslaApiAccounts[username] || this.teslaApiAccounts[username].refresh_failures > 3) {
			this.sendSocketNotification("ReconfigureTeslaAPI", {
				teslaAPIUsername: username
			});
			return false;
		}
		else {
			return true;
		}
	},

	initializeCache: function(node, ...rest) {
		let lastKey = rest.pop();
		for( let key of rest) {
			if( !node[key] ) {
				node[key] = {};
			}
			node = node[key];
		}
		if( !node[lastKey] ) {
			node[lastKey] = {
				lastUpdate: 0,
				lastResult: null
			};
		}
	},

	updateCache: function(data, node, keys, time=null, target="lastResult") {
		if( !time ) {
			time = Date.now();
		}
		if( keys && !Array.isArray(keys) ) {
			keys = [keys];
		}
		let lastKey = keys.pop();
		for( let key of keys) {
			node = node[key];
		}
		node[lastKey].lastUpdate = time;
		node[lastKey][target] = data;
	},

	doTeslaApiGetStormWatch: async function(username, siteID) {
		if( username && siteID ) {
			let url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/live_status";
			let cloudStatus = await this.doTeslaApi(url, username, null, siteID, this.storm);

			this.sendSocketNotification("StormWatch", {
				username: username,
				siteID: siteID,
				storm: cloudStatus.storm_mode_active
			});
		}
	},

	updateTWCManager: async function(twcManagerIP, twcManagerPort) {
		let url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getStatus";
		let success = true;
		let now = Date.now();

		try {
			var result = await fetch(url);
		}
		catch (e) {
			success = false;
		}

		if( success && result.ok ) {
			var status = await result.json();
			var vins = [];
			if( status.carsCharging > 0 ) {
				url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getSlaveTWCs";

				try {
					result = await fetch(url);
				}
				catch {}

				if ( result.ok ) {
					let slaves = await result.json();
					for (let slaveID in slaves) {
						let slave = slaves[slaveID];
						if( slave.currentVIN ) {
							vins.push(slave.currentVIN);
						}
					}
				}
			}

			// Cache results
			this.updateCache(status, this.twcStatus, twcManagerIP, now);
			this.updateCache(vins, this.twcVINs, twcManagerIP, now);

			// Send notification
			this.sendSocketNotification("ChargeStatus", {
				ip: twcManagerIP,
				status: status,
				vins: vins
			});
		}
		else {
			this.log("TWCManager fetch failed")
		}
	},

	updateTWCHistory: async function(twcManagerIP, twcManagerPort) {
		let url = "http://" + twcManagerIP + ":" + twcManagerPort + "/api/getHistory";
		let success = true;
		let now = Date.now();

		try {
			var result = await fetch(url);
		}
		catch (e) {
			success = false;
		}

		if( success && result.ok ) {
			var history = await result.json();
			this.updateCache(history, this.chargeHistory, twcManagerIP, now);
			this.sendSocketNotification("ChargeHistory", {
				twcManagerIP: twcManagerIP,
				chargeHistory: history
			});
		}
	},

	doTeslaApiLogin: async function(username, password) {
		var authenticator = new auth.Authenticator();
		authenticator.on('error', (message) => {
			this.log("Tesla Auth: " + message);
		});
		authenticator.on('ready', async (credentials) => {
			this.log("Got Tesla API tokens")
			this.teslaApiAccounts[username] = credentials.ownerApi;
			this.teslaApiAccounts[username].refresh_token = credentials.auth.refresh_token;
			await fs.writeFile(this.tokenFile, JSON.stringify(this.teslaApiAccounts));
		});
		authenticator.on('mfa', () => {
			this.log("MFA enabled on Tesla account; not supported yet!");
		});
		authenticator.login(username, password);
	},

	inferSiteID: async function(username) {
		url = "https://owner-api.teslamotors.com/api/1/products";

		this.log("Fetching products list");
		let response = await this.doTeslaApi(url, username);
		if( !Array.isArray(response) ) {
			return null;
		}

		let siteIDs = response.filter(
			product =>(product.battery_type === "ac_powerwall")
			).map(product => product.energy_site_id);

		if (siteIDs.length === 1) {
			this.log("Inferred site ID " + siteIDs[0]);
			return siteIDs[0];
		}
		else if (siteIDs.length === 0) {
			console.log("Could not find a Powerwall in your Tesla account");
		}
		else {
			console.log("Found multiple Powerwalls on your Tesla account:" + siteIDs);
			console.log("Add 'siteID' to your config.js to specify which to target");
		}
	},

	log: function(message) {
		if( this.debug ) {
			console.log("MMM-Powerwall: " + message);
		}
	},

	doTeslaApiTokenUpdate: async function(username=null) {
		let accountsToCheck = [username];
		if( !username ) {
			if( Date.now() < this.lastUpdate + 3600000 ) {
				// Only check for expired tokens hourly
				return;
			}
			else {
				this.lastUpdate = Date.now();
			}
			accountsToCheck = Object.keys(this.teslaApiAccounts);
		}

		for( const username of accountsToCheck ) {
			let tokens = this.teslaApiAccounts[username];
			if( tokens && (Date.now() / 1000) > tokens.created_at + (tokens.expires_in / 3)) {
				var authenticator = new auth.Authenticator();
				authenticator.on('error', async (message) => {
					this.log("Tesla refresh failed: " + message);
					if( (Date.now() / 1000) > (tokens.created_at + tokens.expires_in)) {
						// Token is expired; abandon it and try password authentication
						delete this.teslaApiAccounts[username]
						this.checkTeslaCredentials(username);
						await fs.writeFile(this.tokenFile, JSON.stringify(this.teslaApiAccounts));
					}
					else {
						this.teslaApiAccounts[username].refresh_failures =
							1 + (this.teslaApiAccounts[username].refresh_failures || 0);
						await fs.writeFile(this.tokenFile, JSON.stringify(this.teslaApiAccounts));
					}
				});
				authenticator.on('ready', async (credentials) => {
					this.log("Refreshed Tesla API tokens")
					this.teslaApiAccounts[username] = credentials.ownerApi;
					this.teslaApiAccounts[username].refresh_token = credentials.auth.refresh_token;
					await fs.writeFile(this.tokenFile, JSON.stringify(this.teslaApiAccounts));
				});
				await authenticator.refresh(this.teslaApiAccounts[username].refresh_token);
			}
		}
	},

	doTeslaApi: async function(url, username, id_key=null,
			deviceID=null, cache_node=null, event_name=null,
			response_key=null, event_key=null) {
		let result = {};
		let now = Date.now();

		if( !this.teslaApiAccounts[username] ) {
			this.log("Called doTeslaApi() without credentials!")
			return {};
		}
		else {
			await this.doTeslaApiTokenUpdate();
		}

		try {
			result = await fetch(url, {
				headers: {
					"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
				}
			});
		}
		catch (e) {
			this.log(e);
			return null;
		}

		if( result.ok ) {
			let json = await result.json();
			this.log(url + " returned " + JSON.stringify(json).substring(0,150));
			let response = json.response;
			if (response_key) {
				response = response[response_key];
			}

			if( event_name && id_key && event_key ) {
				let event = {
					username: username,
					[id_key]: deviceID,
					[event_key]: response
				};
				this.sendSocketNotification(event_name, event);
			}

			if( response && cache_node && deviceID ) {
				if( !cache_node[username] ) {
					cache_node[username] = {};
				}
				if( !cache_node[username][deviceID] ) {
					cache_node[username][deviceID] = {};
				}
				this.updateCache(response, cache_node, [username, deviceID], now);
			}

			return response;
		}
		else {
			this.log(url + " returned " + result.status);
			this.log(await result.text());
			return null;
		}
	},

	doTeslaApiGetEnergy: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?period=day&kind=energy";
		await this.doTeslaApi(url, username, "siteID", siteID, this.energy, "EnergyData", "time_series", "energy");
	},

	doTeslaApiGetPowerHistory: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?period=day&kind=power";
		await this.doTeslaApi(url, username, "siteID", siteID, this.powerHistory, "PowerHistory", "time_series", "powerHistory");
	},

	doTeslaApiGetBackupHistory: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?kind=backup";
		await this.doTeslaApi(url, username, "siteID", siteID, this.backup, "Backup", "events", "backup");
	},

	doTeslaApiGetSelfConsumption: async function(username, siteID) {
		url = "https://owner-api.teslamotors.com/api/1/energy_sites/" + siteID + "/history?kind=self_consumption&period=day";
		await this.doTeslaApi(url, username, "siteID", siteID, this.selfConsumption, "SelfConsumption", "time_series", "selfConsumption");
	},

	doTeslaApiGetVehicleList: async function(username) {
		url = "https://owner-api.teslamotors.com/api/1/vehicles";
		let response = await this.doTeslaApi(url, username);
		
		// response is an array of vehicle objects.  Don't need all the properties.
		if( Array.isArray(response) ) {
			return response.map(
				function(vehicle) {
					return {
						id: vehicle.id_s,
						vin: vehicle.vin,
						display_name: vehicle.display_name
					}});
		}
		else {
			return [];
		}
	},

	doTeslaApiCommand: async function(url, username, body) {
		if( !this.teslaApiAccounts[username] ) {
			this.log("Called doTeslaApiCommand() without credentials!")
			return {};
		}

		try {
			result = await fetch(url, {
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					"Authorization": "Bearer " + this.teslaApiAccounts[username].access_token
				}
			});
		}
		catch (e) {
			this.log(e);
			return {};
		}

		if( result.ok ) {
			let json = await result.json();
			this.log(JSON.stringify(json));
			let response = json.response;
			return response;
		}
		else {
			this.log(url + " returned " + result.status);
			this.log(await result.text());
			return {};
		}
	},

	delay: function wait(ms) {
		return new Promise(resolve => {
			setTimeout(resolve, ms);
		});
	},

	doTeslaApiWakeVehicle: async function(username, vehicleID) {
		let timeout = 5000;
		let url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/wake_up";
		let state = "initial";

		do {
			let response = await this.doTeslaApiCommand(url, username);
			state = response.state;
			if( response.state !== "online") {
				if( timeout > 20000 ) {
					break;
				}
				await this.delay(timeout);
				timeout *= 2;
			}
		} while( state != "online" );

		return state === "online";
	},

	doTeslaApiGetVehicleData: async function(username, vehicleID, useCached) {
		// Slightly more complicated; involves calling multiple APIs
		let state = "cached";
		const forceWake = !(this.vehicleData[username][vehicleID].lastResult);
		if( !useCached || forceWake ) {
			let url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID;
			let response = await this.doTeslaApi(url, username);
			if( response ) {
				state = response.state;
				if (state !== "online" && forceWake &&
					await this.doTeslaApiWakeVehicle(username, vehicleID)) {
						state = "online";
				}
			}
			else {
				state = "error"
			}
		}

		let dataValid = data => data &&
			["vehicle_state", "drive_state", "gui_settings", "charge_state", "vehicle_config"].
			every(
				key => key in data
			);

		var data = null;
		if( state === "online" ) {
			// Get vehicle state
			url = "https://owner-api.teslamotors.com/api/1/vehicles/" + vehicleID + "/vehicle_data";
			data = await this.doTeslaApi(url, username, "ID", vehicleID, this.vehicleData);
		}

		if( !dataValid(data) ) {
			// Car is asleep and either can't wake or we aren't asking
			data = this.vehicleData[username][vehicleID].lastResult;
			state = "cached";
		}

		if( dataValid(data) )
		{
			let power = data.charge_state.charger_actual_current * data.charge_state.charger_voltage;
			this.sendSocketNotification("VehicleData", {
				username: username,
				ID: vehicleID,
				state: state,
				sentry: data.vehicle_state.sentry_mode,
				drive: {
					speed: data.drive_state.speed,
					units: data.gui_settings.gui_distance_units,
					gear: data.drive_state.shift_state,
					location: [data.drive_state.latitude, data.drive_state.longitude]
				},
				charge: {
					state: data.charge_state.charging_state,
					soc: data.charge_state.battery_level,
					usable_soc: data.charge_state.usable_battery_level,
					limit: data.charge_state.charge_limit_soc,
					power: power,
					time: data.charge_state.time_to_full_charge
				},
				config: {
					car_type: data.vehicle_config.car_type,
					option_codes: data.option_codes,
					exterior_color: data.vehicle_config.exterior_color,
					wheel_type: data.vehicle_config.wheel_type
				}
			});
		}
		else {
			// Car fails to wake and we have no cached data.  Send a sparse response.
			this.sendSocketNotification("VehicleData", {
				username: username,
				ID: vehicleID,
				state: state,
				sentry: undefined,
				drive: {
					speed: undefined,
					units: undefined,
					gear: undefined,
					location: undefined
				},
				charge: {
					state: undefined,
					soc: undefined,
					usable_soc: undefined,
					limit: undefined,
					power: undefined,
					time: undefined
				},
				config: {
					car_type: undefined,
					option_codes: undefined,
					exterior_color: undefined,
					wheel_type: undefined
				}
			});

		}
	}
});
