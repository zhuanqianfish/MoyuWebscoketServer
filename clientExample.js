var n7 = find(7); // CLIP Text Encode (Prompt)
var n101 = find(101); // TextEncodeQwenImageEditPlus
var n103 = find(103); // Load Image
var n104 = find(104); // LayerUtility: ImageScaleByAspectRatio V2
var n118 = find(118); // Load LoRA
var n119 = find(119); // Load CLIP
var n120 = find(120); // Load Diffusion Model
var n121 = find(121); // Load VAE
var n123 = find(123); // Empty Latent Image
var n124 = find(124); // ModelSamplingAuraFlow
var n125 = find(125); // KSampler
var n126 = find(126); // VAE Decode
var n127 = find(127); // Preview Image
var n131 = find(131); // LayerUtility: Image Reel
var n132 = find(132); // LayerUtility: Image Reel Composit
var n142 = find(142); // Load Diffusion Model
var n167 = find(167); // Show Any
var n168 = find(168); // Show Any
var n169 = find(169); // Upscale Image By
var n170 = find(170); // 🔧 Image Resize
var n171 = find(171); // 🔧 Get Image Size
var n172 = find(172); // TTP_Image_Assy
var n173 = find(173); // SeedVR2 (Down)Load DiT Model
var n174 = find(174); // SeedVR2 (Down)Load VAE Model
var n175 = find(175); // Note
var n176 = find(176); // 🔧 Image Resize
var n177 = find(177); // Show Any
var n178 = find(178); // Show Any
var n179 = find(179); // 🔧 Get Image Size
var n180 = find(180); // TTP_Image_Tile_Batch
var n181 = find(181); // TTP_Tile_image_size
var n182 = find(182); // Upscale Image By
var n183 = find(183); // Clean VRAM Used
var n184 = find(184); // 高质量图片压缩
var n185 = find(185); // SeedVR2 Video Upscaler (v2.5.15)
var n188 = find(188); // Save Image
var n189 = find(189); // Save Image
var n191 = find(191); // Preview Image
var n192 = find(192); // Float
var n193 = find(193); // Image Comparer (rgthree)
var n195 = find(195); // 鸭鸭图 SuperSecureMediaProtection媒体内容保护 编码V1.2
var n196 = find(196); // Save Image
var n197 = find(197); // Load Image
var n198 = find(198); // PlaySound 🐍
var n199 = find(199); // Image To Base64
var n200 = find(200); // Save Text
var n201 = find(201); // PlaySound 🐍
var n204 = find(204); // EasySeed
var n205 = find(205); // LATENT WebSocket Sender @ vrch.ai
var n206 = find(206); // PlaySound 🐍
var n208 = find(208); // PlaySound 🐍

// ===================== 发送 Base64 到 Python WebSocket 服务端 =====================
var base64Data = n208.widgets[0].inputEl.value;  //按实际情况修改这行

const HOST = '127.0.0.1';
const PORT = 8001;
const wsUrl = `ws://${HOST}:${PORT}`;

// 创建 WebSocket 并发送
function sendBase64ToServer() {
    try {
        // 从节点 读取 base64 图片

        if (!base64Data || base64Data.trim() === '') {
            console.log("[WebSocket] 无 Base64 数据，跳过发送");
            return;
        }

        // 发送格式：服务端可直接解析
        var payload = JSON.stringify({
            image: base64Data
        });

        // 连接并发送
        const ws = new WebSocket(wsUrl);

        ws.onopen = function () {
            ws.send(payload);
            console.log("✅ 已发送图片 Base64 到 Python 服务端");
            ws.close(1000, "发送完成，关闭连接");
        };

        ws.onerror = function (err) {
            console.log("⚠️ WebSocket 连接失败：", err);
        };

    } catch (e) {
        console.log("❌ 发送失败：", e);
    }
}

// 执行发送
sendBase64ToServer();