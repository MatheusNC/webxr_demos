/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { AXES, XR_BUTTONS } from 'gamepad-wrapper';
import {
	CapsuleGeometry,
	Group,
	LoadingManager,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	Raycaster,
	ShadowMaterial,
	SphereGeometry,
	TorusGeometry,
	Vector3,
} from 'three';
import { Root, Text } from '@pmndrs/uikit';

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { System } from 'elics';
import { createFurnitureMarker } from './marker';
import { globals } from './global';

export class FurnitureSystem extends System {
	init() {
		this.raycaster = new Raycaster();
		const manager = new LoadingManager();
		const DRACO_LOADER = new DRACOLoader(manager).setDecoderPath(
			`vendor/draco/gltf/`,
		);
		const KTX2_LOADER = new KTX2Loader(manager).setTranscoderPath(
			`vendor/basis/`,
		);
		const gltfLoader = new GLTFLoader(manager)
			.setCrossOrigin('anonymous')
			.setDRACOLoader(DRACO_LOADER)
			.setKTX2Loader(KTX2_LOADER.detectSupport(globals.renderer));
		this._gltfLoader = gltfLoader;
		this._notes = [];
		this._notePickables = [];
		this._hoveredNote = null;
		this._activeNoteInput = null;
		this._activeConfirm3D = null;
		this._notesLoaded = false;
		import('@dimforge/rapier3d').then((RAPIER) => {
			this.RAPIER = RAPIER;
			// Use the RAPIER module here.
			let gravity = { x: 0.0, y: -9.81, z: 0.0 };
			let world = new RAPIER.World(gravity);

			// Create the ground
			let groundColliderDesc = RAPIER.ColliderDesc.cuboid(
				10.0,
				0,
				10.0,
			).setFriction(0.5);
			this.floorCollider = world.createCollider(groundColliderDesc);

			// Create a dynamic rigid-body.
			let rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(0.0, 3.0, 0.0)
				.setAngularDamping(1)
				.lockRotations();
			let rigidBody = world.createRigidBody(rigidBodyDesc);
			rigidBody.setEnabledRotations(false, true, false);

			// Create a cuboid collider attached to the dynamic rigidBody.
			let colliderDesc = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setFriction(
				0,
			);
			world.createCollider(colliderDesc, rigidBody);

			this.rapierWorld = world;
			this.rigidBody = rigidBody;

			window.setTarget = (x, y, z) => {
				this.target = new Vector3(x, y, z);
			};
		});
		this._furnitureLoading = false;
	}

	update(delta) {
		if (!this.RAPIER) return;

		if (!this.cube) {
			const { ratk, scene } = globals;
			this.cube = new Group();
			const furnitureMarker = createFurnitureMarker();
			furnitureMarker.position.set(0, -0.5, 0);
			this.cube.add(furnitureMarker);
			scene.add(this.cube);

			const floorGeometry = new PlaneGeometry(1000, 1000);
			floorGeometry.rotateX(-Math.PI / 2);
			this.floor = new Mesh(
				floorGeometry,
				new ShadowMaterial({
					opacity: 0.75,
				}),
			);
			this.floor.receiveShadow = true;
			scene.add(this.floor);

			this.targetMarker = new Mesh(
				new SphereGeometry(0.05, 32, 16),
				new MeshBasicMaterial({
					color: 0xffffff,
					transparent: true,
					opacity: 0.5,
				}),
			);
			scene.add(this.targetMarker);

			/**
			 *
			 * @param {import('ratk').Plane} plane
			 */
			ratk.onPlaneAdded = (plane) => {
				plane.visible = false;
				if (plane.orientation === 'vertical') {
					const wallColliderDesc = this.RAPIER.ColliderDesc.cuboid(
						plane.boundingRectangleWidth,
						0,
						plane.boundingRectangleHeight,
					)
						.setTranslation(...plane.position.toArray())
						.setRotation(plane.quaternion);
					this.rapierWorld.createCollider(wallColliderDesc);
				} else if (plane.semanticLabel === 'floor') {
					this.raycaster.set(new Vector3(0, 2, 0), new Vector3(0, -1, 0));
					const intersect = this.raycaster.intersectObject(plane.planeMesh)[0]
						?.point;
					if (!intersect) return;
					this.rapierWorld.removeCollider(this.floorCollider);
					let updatedColliderDesc = this.RAPIER.ColliderDesc.cuboid(
						10.0,
						0,
						10.0,
					)
						.setTranslation(0, intersect.y, 0) // Set new position
						.setFriction(0.5); // Set new friction
					this.floorCollider =
						this.rapierWorld.createCollider(updatedColliderDesc);
					this.floor.position.y = intersect.y;
					this.rigidBody.setTranslation({ x: 0, y: intersect.y + 3, z: 0 });
				}
			};

			// Load persisted notes after scene primitives exist
			if (!this._notesLoaded) {
				this._loadNotesFromStorage();
				this._notesLoaded = true;
			}
		}

		if (globals.furnitureToSpawn) {
			if (!this.cube.userData.furnitureModel && !this._furnitureLoading) {
				this._furnitureLoading = true;
				this._gltfLoader.load('assets/' + globals.furnitureToSpawn, (gltf) => {
					const modelRoot = gltf.scene;
					modelRoot.position.y -= 0.5;
					this.cube.add(modelRoot);
					this.cube.userData.furnitureModel = modelRoot;
					this._furnitureLoading = false;
				});
			}
			globals.furnitureToSpawn = null;
		}

		const controller = globals.controllers['right'];

		if (!controller?.targetRaySpace) {
			this.targetMarker.visible = false;
			return;
		}

		if (controller?.gamepadWrapper) {
			if (controller.gamepadWrapper.getButtonDown(XR_BUTTONS.TRIGGER)) {
				this.finalizeFurniturePosition();
			}
		}

		// Compute world-space ray origin and direction from controller
		const _origin = new Vector3();
		controller.targetRaySpace.getWorldPosition(_origin);
		this.raycaster.set(
			_origin,
			controller.targetRaySpace.getWorldDirection(new Vector3()).negate(),
		);
		const target = this.raycaster.intersectObject(this.floor, false)[0]?.point;

		// (handled after hover detection)

		// Detect hovered note for interactions
		let hovered = null;
		if (this._notePickables.length) {
			const hit = this.raycaster.intersectObjects(this._notePickables, true)[0];
			if (hit?.object?.userData?.note) hovered = hit.object.userData.note;
		}
		if (this._hoveredNote !== hovered) {
			// Unhighlight previous and hide all labels
			if (this._hoveredNote?.torus) this._hoveredNote.torus.scale.set(1, 1, 1);
			for (const n of this._notes) {
				if (n?.root) n.root.visible = false;
			}
			this._hoveredNote = hovered;
			// Highlight current and show its label
			if (this._hoveredNote?.torus) this._hoveredNote.torus.scale.set(1.15, 1.15, 1.15);
			if (this._hoveredNote?.root) this._hoveredNote.root.visible = true;
		}

		// B (BUTTON_2): if hovering a note, open delete confirm; else create new note
		if (controller?.gamepadWrapper?.getButtonClick(XR_BUTTONS.BUTTON_2)) {
			if (this._hoveredNote) {
				this._openDeleteConfirm(this._hoveredNote);
			} else if (!this._activeConfirm3D) {
				const placement = target
					? target.clone()
					: new Vector3().copy(this.cube.position);
				this.createNoteMarker(placement);
			}
		}

		// Edit hovered note with A (BUTTON_1)
		if (this._hoveredNote && controller?.gamepadWrapper?.getButtonClick(XR_BUTTONS.BUTTON_1)) {
			this._openNoteInput(this._hoveredNote);
		}

		// Remove hovered note with SQUEEZE
		if (this._hoveredNote && controller?.gamepadWrapper?.getButtonClick(XR_BUTTONS.SQUEEZE)) {
			this._removeNote(this._hoveredNote);
		}

		if (target) {
			this.targetMarker.visible = true;
			this.targetMarker.position.copy(target);
			// Get the current position of the rigid body
			let position = new Vector3().copy(this.rigidBody.translation());
			// Calculate the direction vector
			let dir = new Vector3().subVectors(target, position);
			// Check if the rigid body has reached the target
			if (dir.length() < 0.01) {
				// The rigid body is close enough to the target, so we can stop it
				this.rigidBody.setLinvel(new this.RAPIER.Vector3(0, 0, 0), true);
			} else {
				// Normalize the direction vector and scale it by the speed
				let velocity = dir.normalize().multiplyScalar(0.1);
				// Calculate the impulse
				let impulse = velocity.multiplyScalar(this.rigidBody.mass());
				// Apply the impulse
				this.rigidBody.applyImpulse(impulse, true);
			}
		} else {
			this.targetMarker.visible = false;
		}

		const thumbstickValue = controller.gamepadWrapper.getAxis(
			AXES.XR_STANDARD.THUMBSTICK_X,
		);

		// Maximum rotation speed
		let maxRotationSpeed = -0.06; // Adjust this value to your needs
		// Thumbstick value
		// Calculate the torque impulse
		let torqueImpulse = new this.RAPIER.Vector3(
			0,
			thumbstickValue * maxRotationSpeed,
			0,
		);
		// Apply the torque impulse
		this.rigidBody.applyTorqueImpulse(torqueImpulse, true);

		this.rapierWorld.timestep = delta;
		this.rapierWorld.step();

		this.cube.position.copy(this.rigidBody.translation());
		this.cube.quaternion.copy(this.rigidBody.rotation());

		if (this.cube.position.y < -5) {
			this.rigidBody.setTranslation({ x: 0, y: 3, z: 0 });
		}

		// Update 3D UI roots and billboard for notes
		if (this._notes && this._notes.length) {
			for (const note of this._notes) {
				note.root.update(delta * 1000);
				// Make exclamation face the camera
				if (globals.camera && note.billboard) note.billboard.lookAt(globals.camera.position);
			}
		}

		// Drive confirm 3D loop if active
		if (this._confirmLoop) this._confirmLoop();
	}

	finalizeFurniturePosition() {
		// Detach the furniture model from the cube
		const furnitureModel = this.cube.userData.furnitureModel;
		if (furnitureModel) {
			globals.scene.attach(furnitureModel);
			furnitureModel.castShadow = true;
			this.cube.userData.furnitureModel = null;
		} else {
			return;
		}

		// Create a new fixed rigid body for the furniture at its current position
		const translation = this.rigidBody.translation();
		const fixedRigidBodyDesc = this.RAPIER.RigidBodyDesc.fixed()
			.setTranslation(translation.x, translation.y, translation.z)
			.setRotation(this.rigidBody.rotation());
		const fixedRigidBody = this.rapierWorld.createRigidBody(fixedRigidBodyDesc);

		// Attach the furniture model to the new fixed rigid body
		const colliderDesc = this.RAPIER.ColliderDesc.cuboid(
			0.5,
			0.5,
			0.5,
		).setFriction(0.5);
		this.rapierWorld.createCollider(colliderDesc, fixedRigidBody);

		// Reset the cube's rigid body's position to its starting point
		this.rigidBody.setTranslation(new this.RAPIER.Vector3(0.0, 3.0, 0.0), true);
		this.rigidBody.setLinvel(new this.RAPIER.Vector3(0, 0, 0), true);
		this.rigidBody.setAngvel(new this.RAPIER.Vector3(0, 0, 0), true);
	}

	createNoteMarker(position, content = '', openInput = true, id = undefined) {
		const { scene, camera, renderer } = globals;
		const markerGroup = new Group();
		markerGroup.position.copy(position);

		// Visual: sphere + torus halo
		const sphere = new Mesh(
			new SphereGeometry(0.055, 24, 18),
			new MeshBasicMaterial({ color: 0xffe066 }),
		);
		markerGroup.add(sphere);

		const torus = new Mesh(
			new TorusGeometry(0.12, 0.012, 16, 48),
			new MeshBasicMaterial({ color: 0xff9f1c }),
		);
		torus.rotation.x = Math.PI / 2;
		markerGroup.add(torus);

		// Exclamation billboard
		const billboard = new Group();
		billboard.position.set(0, 0.14, 0);
		markerGroup.add(billboard);
		const bar = new Mesh(
			new CapsuleGeometry(0.012, 0.16, 4, 8),
			new MeshBasicMaterial({ color: 0xff3b30 }),
		);
		bar.position.y = 0.1;
		const dot = new Mesh(
			new SphereGeometry(0.02, 16, 12),
			new MeshBasicMaterial({ color: 0xff3b30 }),
		);
		dot.position.y = -0.02;
		billboard.add(bar);
		billboard.add(dot);

		// Label using UIKit
		const labelAnchor = new Group();
		labelAnchor.position.set(0, 0.26, 0);
		markerGroup.add(labelAnchor);
		const root = new Root(camera, renderer, undefined, {
			backgroundColor: 'white',
			backgroundOpacity: 0.92,
			padding: 0.25,
			borderRadius: 0.18,
		});
		labelAnchor.add(root);
		const textNode = new Text(content || '', {
			fontSize: 0.4,
			fontWeight: 'bold',
			color: 'black',
			maxWidth: 3,
		});
		root.add(textNode);
		root.visible = false;

		scene.add(markerGroup);

		// Track for picking and persistence
		const note = {
			id: id || `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
			group: markerGroup,
			root,
			textNode,
			content: content || '',
			sphere,
			torus,
			billboard,
		};
		for (const pickable of [sphere, torus, bar, dot]) {
			pickable.userData.note = note;
			this._notePickables.push(pickable);
		}
		this._notes.push(note);
		this._saveNotesToStorage();
		if (openInput) this._openNoteInput(note);
	}

	_openNoteInput(note) {
		if (this._activeNoteInput) {
			this._activeNoteInput.remove();
			this._activeNoteInput = null;
		}
		const container = document.createElement('div');
		container.style.position = 'fixed';
		container.style.left = '50%';
		container.style.bottom = '16px';
		container.style.transform = 'translateX(-50%)';
		container.style.zIndex = '9999';
		container.style.background = 'rgba(255,255,255,0.95)';
		container.style.padding = '8px';
		container.style.borderRadius = '6px';
		container.style.boxShadow = '0 2px 12px rgba(0,0,0,0.25)';

		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'Digite uma anotação para o marcador...';
		input.style.minWidth = '260px';
		input.style.marginRight = '8px';
		input.value = note.content || '';

		const save = document.createElement('button');
		save.textContent = 'Salvar';
		save.className = 'btn btn-sm btn-primary';
		save.onclick = () => {
			note.content = input.value.trim();
			try {
				if (typeof note.textNode.setText === 'function') {
					note.textNode.setText(note.content);
				} else {
					note.root.remove(note.textNode);
					note.textNode = new Text(note.content, {
						fontSize: 0.4,
						fontWeight: 'bold',
						color: 'black',
					});
					note.root.add(note.textNode);
				}
			} catch (e) {
				console.warn('Falha ao atualizar texto do marcador:', e);
			}
			this._saveNotesToStorage();
			container.remove();
			this._activeNoteInput = null;
		};

		const cancel = document.createElement('button');
		cancel.textContent = 'Cancelar';
		cancel.className = 'btn btn-sm btn-secondary';
		cancel.style.marginLeft = '6px';
		cancel.onclick = () => {
			container.remove();
			this._activeNoteInput = null;
		};

		const removeBtn = document.createElement('button');
		removeBtn.textContent = 'Excluir';
		removeBtn.className = 'btn btn-sm btn-danger';
		removeBtn.style.marginLeft = '6px';
		removeBtn.onclick = () => {
			this._removeNote(note);
			container.remove();
			this._activeNoteInput = null;
		};

		container.appendChild(input);
		container.appendChild(save);
		container.appendChild(cancel);
		container.appendChild(removeBtn);
		document.body.appendChild(container);
		this._activeNoteInput = container;
		input.focus();
	}

	_openDeleteConfirm(note) {
		const { camera, renderer } = globals;
		if (this._activeConfirm3D) {
			this._activeConfirm3D.parent?.remove(this._activeConfirm3D);
			this._activeConfirm3D = null;
		}
		const anchor = new Group();
		anchor.position.copy(note.group.position);
		anchor.position.y += 0.35;
		globals.scene.add(anchor);
		const root = new Root(camera, renderer, undefined, {
			backgroundColor: 'white',
			backgroundOpacity: 0.95,
			padding: 0.25,
			borderRadius: 0.18,
			flexDirection: 'column',
			alignItems: 'center',
			gap: 0.2,
		});
		anchor.add(root);
		root.add(new Text('Excluir este marcador?', {
			fontSize: 0.45,
			fontWeight: 'bold',
			color: 'black',
			textAlign: 'center',
			maxWidth: 3,
		}));
		// Buttons row
		const row = new Group();
		root.add(row);
		const confirm = new Root(camera, renderer, undefined, {
			backgroundColor: '#dc3545',
			backgroundOpacity: 1,
			padding: 0.2,
			borderRadius: 0.12,
		});
		confirm.add(new Text('Excluir', { fontSize: 0.35, color: 'white' }));
		const cancel = new Root(camera, renderer, undefined, {
			backgroundColor: '#6c757d',
			backgroundOpacity: 1,
			padding: 0.2,
			borderRadius: 0.12,
		});
		cancel.add(new Text('Cancelar', { fontSize: 0.35, color: 'white' }));
		// Simple layout using Three groups
		const left = new Group();
		const right = new Group();
		left.add(confirm);
		right.add(cancel);
		left.position.x = -0.6;
		right.position.x = 0.6;
		row.add(left);
		row.add(right);

		// Interaction using ray hits (reuse hovered logic): we consider it confirmed when BUTTON_1 is clicked while hovering over confirm/cancel areas
		const pickables = [confirm, cancel];
		for (const p of pickables) p.userData.type = 'confirm-ui';
		const onFrame = () => {
			// billboard
			if (globals.camera) anchor.lookAt(globals.camera.position);
			root.update(16);
			if (!globals.controllers?.right?.targetRaySpace) return;
			const r = this.raycaster;
			const origin = new Vector3();
			globals.controllers.right.targetRaySpace.getWorldPosition(origin);
			r.set(origin, globals.controllers.right.targetRaySpace.getWorldDirection(new Vector3()).negate());
			const uiHits = r.intersectObjects(pickables, true);
			const overConfirm = uiHits.some((h) => h.object === confirm || confirm.children?.includes?.(h.object));
			const overCancel = uiHits.some((h) => h.object === cancel || cancel.children?.includes?.(h.object));
			if (globals.controllers.right.gamepadWrapper?.getButtonClick(XR_BUTTONS.BUTTON_1)) {
				if (overConfirm) {
					this._removeNote(note);
					cleanup();
				} else if (overCancel) {
					cleanup();
				}
			}
		};
		const cleanup = () => {
			globals.scene.remove(anchor);
			this._activeConfirm3D = null;
			this._confirmLoop = null;
		};
		this._confirmLoop = onFrame;
		this._activeConfirm3D = anchor;
	}

	_removeNote(note) {
		if (!note) return;
		globals.scene.remove(note.group);
		this._notePickables = this._notePickables.filter((o) => o.userData.note !== note);
		this._notes = this._notes.filter((n) => n !== note);
		this._hoveredNote = null;
		this._saveNotesToStorage();
	}

	_saveNotesToStorage() {
		try {
			const data = this._notes.map((n) => ({
				id: n.id,
				content: n.content,
				position: [n.group.position.x, n.group.position.y, n.group.position.z],
			}));
			localStorage.setItem('chairs-etc:notes', JSON.stringify(data));
		} catch (e) {
			console.warn('Falha ao salvar notas:', e);
		}
	}

	_loadNotesFromStorage() {
		try {
			const raw = localStorage.getItem('chairs-etc:notes');
			if (!raw) return;
			const arr = JSON.parse(raw);
			if (!Array.isArray(arr)) return;
			for (const item of arr) {
				const pos = new Vector3(
					Number(item?.position?.[0]) || 0,
					Number(item?.position?.[1]) || 0,
					Number(item?.position?.[2]) || 0,
				);
				this.createNoteMarker(pos, String(item?.content || ''), false, item?.id);
			}
		} catch (e) {
			console.warn('Falha ao carregar notas:', e);
		}
	}
}
