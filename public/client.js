const socket = io();

// Global variables
let localStream = null;
let cameraTrack = null;      // Current video track
let screenStream = null;     // Screen sharing stream
let peers = {};              // socketId -> RTCPeerConnection
let userNames = {};          // socketId -> userName
let remoteStreams = {};      // socketId -> MediaStream
let userCanShare = {};       // socketId -> boolean (permission to share video)
let remoteMuted = {};        // socketId -> boolean for remote mute state
let roomId;
let isAdmin = false;
let myUserName = "";
let canShareVideo = false;   // For this client
let adminSocketId = null;
let isMuted = false;         // Local mute state

// DOM elements
const landingDiv = document.getElementById('landing');
const createMeetingBtn = document.getElementById('createMeetingBtn');
const joinMeetingBtn = document.getElementById('joinMeetingBtn');

const createSection = document.getElementById('createSection');
const createNameInput = document.getElementById('createName');
const createNowBtn = document.getElementById('createNowBtn');

const joinSection = document.getElementById('joinSection');
const joinNameInput = document.getElementById('joinName');
const joinIdInput = document.getElementById('joinId');
const joinNowBtn = document.getElementById('joinNowBtn');

const meetingContainer = document.getElementById('meetingContainer');
const meetingIdDisplay = document.getElementById('meetingIdDisplay');

const enableMediaDiv = document.getElementById('enableMediaDiv');
const enableMediaBtn = document.getElementById('enableMediaBtn');

const mainVideo = document.getElementById('mainVideo');
const mainNameEl = document.getElementById('mainName');
const participantUl = document.getElementById('participantUl');

const controlsDiv = document.getElementById('controls');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const stopScreenBtn = document.getElementById('stopScreenBtn');

const chatSection = document.getElementById('chatSection');
const chatDiv = document.getElementById('chat');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');

const videoModal = document.getElementById('videoModal');
const modalVideo = document.getElementById('modalVideo');
const modalName = document.getElementById('modalName');
const closeModalBtn = document.getElementById('closeModal');

// New Device Settings Elements
const deviceSettingsDiv = document.getElementById('deviceSettings');
const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const muteMicBtn = document.getElementById('muteMicBtn');

// STUN server configuration
const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

/* ----------------------------------------------------------------
   HELPER FUNCTIONS
------------------------------------------------------------------ */
function updateShareButtons() {
  if (!canShareVideo) {
    controlsDiv.style.display = 'none';
    shareScreenBtn.style.display = 'none';
    stopScreenBtn.style.display = 'none';
    return;
  }
  controlsDiv.style.display = 'block';
  if (screenStream) {
    shareScreenBtn.style.display = 'none';
    stopScreenBtn.style.display = 'inline';
  } else {
    shareScreenBtn.style.display = 'inline';
    stopScreenBtn.style.display = 'none';
  }
}

function updateMuteButton() {
  muteMicBtn.textContent = isMuted ? "Unmute Mic" : "Mute Mic";
}

/* Populate camera and mic dropdowns */
async function populateDeviceDropdowns() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    cameraSelect.innerHTML = "";
    videoInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Camera ${cameraSelect.length + 1}`;
      cameraSelect.appendChild(option);
    });

    micSelect.innerHTML = "";
    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Mic ${micSelect.length + 1}`;
      micSelect.appendChild(option);
    });

    deviceSettingsDiv.style.display = 'block';
  } catch (err) {
    console.error("Error populating devices:", err);
  }
}

/* Switch camera track */
async function switchCamera(deviceId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
    const newVideoTrack = stream.getVideoTracks()[0];
    // Update local stream and replace in peers
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.stop());
      localStream.removeTrack(cameraTrack);
      localStream.addTrack(newVideoTrack);
      cameraTrack = newVideoTrack;
      mainVideo.srcObject = localStream;
      // Update sender for each peer
      for (let socketId in peers) {
        const sender = peers[socketId].getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
          await renegotiatePeer(socketId);
        }
      }
      // Update display name to indicate camera feed
      mainNameEl.textContent = myUserName + " (Camera)";
    }
  } catch (err) {
    console.error("Error switching camera:", err);
  }
}

/* Switch mic track */
async function switchMic(deviceId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const newAudioTrack = stream.getAudioTracks()[0];
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.stop());
      // Remove old audio tracks and add new one
      localStream.getAudioTracks().forEach(track => localStream.removeTrack(track));
      localStream.addTrack(newAudioTrack);
      // Update peers with new audio track
      for (let socketId in peers) {
        const sender = peers[socketId].getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(newAudioTrack);
          await renegotiatePeer(socketId);
        }
      }
    }
  } catch (err) {
    console.error("Error switching mic:", err);
  }
}

/* ----------------------------------------------------------------
   DEVICE SETTINGS EVENTS
------------------------------------------------------------------ */
cameraSelect.addEventListener('change', () => {
  const selectedCamera = cameraSelect.value;
  if (selectedCamera) {
    switchCamera(selectedCamera);
  }
});

micSelect.addEventListener('change', () => {
  const selectedMic = micSelect.value;
  if (selectedMic) {
    switchMic(selectedMic);
  }
});

muteMicBtn.addEventListener('click', () => {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
  }
  updateMuteButton();
});

/* ----------------------------------------------------------------
   LANDING PAGE LOGIC
------------------------------------------------------------------ */
createMeetingBtn.addEventListener('click', () => {
  landingDiv.style.display = 'none';
  createSection.style.display = 'block';
});

joinMeetingBtn.addEventListener('click', () => {
  landingDiv.style.display = 'none';
  joinSection.style.display = 'block';
});

createNowBtn.addEventListener('click', () => {
  myUserName = createNameInput.value.trim();
  if (!myUserName) {
    alert('Please enter your name.');
    return;
  }
  isAdmin = true;
  canShareVideo = true;
  roomId = generateMeetingId();

  createSection.style.display = 'none';
  showMeetingUI();
  updateShareButtons();

  socket.emit('join-room', roomId, isAdmin, myUserName);
});

joinNowBtn.addEventListener('click', () => {
  myUserName = joinNameInput.value.trim();
  const inputId = joinIdInput.value.trim();
  if (!myUserName || !inputId) {
    alert('Please enter name and meeting ID.');
    return;
  }
  isAdmin = false;
  canShareVideo = false; // non-admin default
  roomId = inputId;

  joinSection.style.display = 'none';
  showMeetingUI();
  updateShareButtons();

  socket.emit('join-room', roomId, isAdmin, myUserName);
});

function generateMeetingId() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

function showMeetingUI() {
  meetingContainer.style.display = 'flex';
  chatSection.style.display = 'block';
  enableMediaDiv.style.display = 'block';
  meetingIdDisplay.textContent = roomId;
  mainNameEl.textContent = myUserName;
}

/* ----------------------------------------------------------------
   SOCKET EVENTS & MEETING LOGIC
------------------------------------------------------------------ */
socket.on('existing-users', (users) => {
  users.forEach(u => {
    userNames[u.socketId] = u.userName;
    userCanShare[u.socketId] = u.canShareVideo;
    if (u.isAdmin) adminSocketId = u.socketId;
    createPeerConnection(u.socketId, true);
  });
  updateParticipantList();
});

socket.on('user-connected', (data) => {
  userNames[data.socketId] = data.userName;
  userCanShare[data.socketId] = data.canShareVideo;
  if (data.isAdmin && !isAdmin) {
    adminSocketId = data.socketId;
  }
  updateParticipantList();
  if (isAdmin && localStream) {
    createPeerConnection(data.socketId, true);
    renegotiatePeer(data.socketId);
  }
});

socket.on('admin-changed', (data) => {
  if (data.newAdmin === socket.id) {
    isAdmin = true;
    canShareVideo = true;
  }
  if (data.oldAdmin === socket.id) {
    isAdmin = false;
    canShareVideo = false;
  }
  updateShareButtons();
  updateParticipantList();
});

socket.on('sharing-allowed', () => {
  canShareVideo = true;
  alert('You are now allowed to share screen/camera.');
  updateShareButtons();
});

socket.on('sharing-disallowed', () => {
  canShareVideo = false;
  alert('Your permission to share screen/camera has been removed.');
  if (screenStream) {
    stopScreenSharing();
  }
  updateShareButtons();
});

socket.on('mute-user', (data) => {
  // data: { mute: boolean }
  if (localStream) {
    localStream.getAudioTracks().forEach(track => track.enabled = !data.mute);
  }
  isMuted = data.mute;
  updateMuteButton();
});

socket.on('user-disconnected', (socketId) => {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  delete userNames[socketId];
  delete remoteStreams[socketId];
  delete userCanShare[socketId];
  updateParticipantList();
});

socket.on('kicked', () => {
  alert('You have been kicked by the admin.');
  window.location.reload();
});

/* ----------------------------------------------------------------
   CHAT FUNCTIONALITY
------------------------------------------------------------------ */
sendChatBtn.addEventListener('click', () => {
  const msg = chatInput.value.trim();
  if (!msg) return;
  socket.emit('chat-message', msg);
  appendChatMessage('Me', msg);
  chatInput.value = '';
});

socket.on('chat-message', (data) => {
  if (data.from === myUserName) return;
  appendChatMessage(data.from, data.message);
});

function appendChatMessage(sender, message) {
  const p = document.createElement('p');
  p.textContent = `${sender}: ${message}`;
  chatDiv.appendChild(p);
  chatDiv.scrollTop = chatDiv.scrollHeight;
}

/* ----------------------------------------------------------------
   ENABLE MEDIA
------------------------------------------------------------------ */
enableMediaBtn.addEventListener('click', async () => {
  try {
    let constraints = { audio: true, video: false };
    if (canShareVideo) {
      constraints.video = true;
    }
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    mainVideo.srcObject = localStream;

    if (constraints.video && localStream.getVideoTracks().length > 0) {
      cameraTrack = localStream.getVideoTracks()[0];
    }
    // Populate device dropdowns now that we have permission
    populateDeviceDropdowns();

    // Add local stream to all peers
    for (let socketId in peers) {
      localStream.getTracks().forEach(track => {
        let sender = peers[socketId].getSenders().find(s => s.track && s.track.kind === track.kind);
        if (!sender) {
          peers[socketId].addTrack(track, localStream);
        } else {
          sender.replaceTrack(track);
        }
      });
      await renegotiatePeer(socketId);
    }
    enableMediaDiv.style.display = 'none';
  } catch (err) {
    console.error('Error accessing media devices:', err);
    alert('Could not access microphone/camera.');
  }
});

/* ----------------------------------------------------------------
   SIGNALING
------------------------------------------------------------------ */
socket.on('signal', async (data) => {
  if (!peers[data.from]) {
    createPeerConnection(data.from, false);
  }
  const pc = peers[data.from];
  if (data.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.message));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', {
      roomId,
      type: 'answer',
      message: pc.localDescription,
      to: data.from
    });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.message));
  } else if (data.type === 'ice-candidate') {
    try {
      await pc.addIceCandidate(data.message);
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }
});

/* ----------------------------------------------------------------
   PEER CONNECTIONS
------------------------------------------------------------------ */
function createPeerConnection(socketId, isInitiator) {
  if (peers[socketId]) return;
  const pc = new RTCPeerConnection(configuration);
  peers[socketId] = pc;
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  pc.ontrack = (event) => {
    remoteStreams[socketId] = event.streams[0];
    updateParticipantList();
    if (!isAdmin && socketId === adminSocketId && remoteStreams[socketId]) {
      mainVideo.srcObject = remoteStreams[socketId];
      mainNameEl.textContent = userNames[socketId];
    }
  };
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        roomId,
        type: 'ice-candidate',
        message: event.candidate,
        to: socketId
      });
    }
  };
  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', {
          roomId,
          type: 'offer',
          message: pc.localDescription,
          to: socketId
        });
      } catch (err) {
        console.error('Error during negotiation:', err);
      }
    };
  }
}

async function renegotiatePeer(socketId) {
  const pc = peers[socketId];
  if (!pc) return;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', {
      roomId,
      type: 'offer',
      message: pc.localDescription,
      to: socketId
    });
  } catch (err) {
    console.error('Error renegotiating with peer', socketId, err);
  }
}

/* ----------------------------------------------------------------
   PARTICIPANT LIST & ADMIN DROPDOWN
------------------------------------------------------------------ */
function updateParticipantList() {
  participantUl.innerHTML = "";
  Object.keys(userNames).forEach(socketId => {
    if (socketId === socket.id) return;
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'participantName';
    nameSpan.textContent = userNames[socketId];
    if (remoteStreams[socketId]) {
      nameSpan.textContent += ' (View)';
      nameSpan.style.color = 'green';
    }
    nameSpan.onclick = () => {
      if (remoteStreams[socketId]) {
        openModal(socketId);
      } else {
        alert(userNames[socketId] + ' is not broadcasting media yet.');
      }
    };
    li.appendChild(nameSpan);

    if (isAdmin) {
      const actionsSelect = document.createElement('select');
      actionsSelect.innerHTML = `<option value="">Actions</option>
        <option value="kick">Kick</option>
        <option value="makeAdmin">Make Admin</option>`;
      if (userCanShare[socketId]) {
        actionsSelect.innerHTML += `<option value="removeShare">Remove Screen/Camera</option>`;
      } else {
        actionsSelect.innerHTML += `<option value="allowShare">Allow Screen/Camera</option>`;
      }
      // Add mute/unmute options based on remote mute state
      if (remoteMuted[socketId]) {
        actionsSelect.innerHTML += `<option value="unmuteUser">Unmute Mic</option>`;
      } else {
        actionsSelect.innerHTML += `<option value="muteUser">Mute Mic</option>`;
      }
      actionsSelect.onchange = (e) => {
        const val = e.target.value;
        e.target.value = "";
        if (val === 'kick') {
          socket.emit('kick-user', socketId);
        } else if (val === 'makeAdmin') {
          socket.emit('make-admin', socketId);
        } else if (val === 'allowShare') {
          socket.emit('allow-sharing', socketId);
          userCanShare[socketId] = true;
        } else if (val === 'removeShare') {
          socket.emit('disallow-sharing', socketId);
          userCanShare[socketId] = false;
        } else if (val === 'muteUser') {
          socket.emit('mute-user', { targetSocketId: socketId, mute: true });
          remoteMuted[socketId] = true;
        } else if (val === 'unmuteUser') {
          socket.emit('mute-user', { targetSocketId: socketId, mute: false });
          remoteMuted[socketId] = false;
        }
        updateParticipantList();
      };
      li.appendChild(actionsSelect);
    }
    participantUl.appendChild(li);
  });
}

function openModal(socketId) {
  modalVideo.srcObject = remoteStreams[socketId];
  modalName.textContent = userNames[socketId];
  videoModal.style.display = "flex";
}

closeModalBtn.addEventListener('click', () => {
  videoModal.style.display = "none";
});

/* ----------------------------------------------------------------
   SCREEN SHARING
------------------------------------------------------------------ */
shareScreenBtn.addEventListener('click', async () => {
  if (!canShareVideo) {
    alert('You are not allowed to share screen.');
    return;
  }
  try {
    const sStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const sTrack = sStream.getVideoTracks()[0];
    screenStream = sStream;
    if (!localStream) {
      localStream = sStream;
      mainVideo.srcObject = localStream;
      cameraTrack = null;
    }
    for (let socketId in peers) {
      const sender = peers[socketId].getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(sTrack);
      } else {
        peers[socketId].addTrack(sTrack, sStream);
      }
      await renegotiatePeer(socketId);
    }
    mainVideo.srcObject = sStream;
    sTrack.onended = () => {
      stopScreenSharing();
    };
    updateShareButtons();
  } catch (err) {
    console.error('Error sharing screen:', err);
  }
});

stopScreenBtn.addEventListener('click', async () => {
  await stopScreenSharing();
});

async function stopScreenSharing() {
  try {
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
    if (cameraTrack) {
      for (let socketId in peers) {
        const sender = peers[socketId].getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(cameraTrack);
          await renegotiatePeer(socketId);
        }
      }
      mainVideo.srcObject = localStream;
    } else {
      mainVideo.srcObject = null;
      localStream = null;
      enableMediaDiv.style.display = 'block';
    }
    updateShareButtons();
  } catch (err) {
    console.error('Error stopping screen sharing:', err);
  }
}
