# MMM-Nest-Camera-WebRTC

MagicMirror2 Module for viewing Google Nest cameras using WebRTC technology.

## Installation

1. Navigate to your MagicMirror modules folder in a terminal:
```bash
cd modules
```

2. Clone this repository:
```bash
git clone https://github.com/brandaorafael/MMM-Nest-Camera-WebRTC
```

3. Add the configuration for this module in your `config.js`
```json
{
  module: "MMM-Nest-Camera-WebRTC",
  position: "bottom_left",
  config: {
    nestProjectId: "",
    nestDeviceId: "",
    token: ""
  }
}
```

### Updating
To update this module, navigate to the module folder (cd modules/MMM-Nest-Camera-WebRTC) and pull from the repository using:
```bash
git pull
```

## Requirements

You need to get [Google Credentials](https://console.cloud.google.com/apis/credentials) and also requires a project at [Device Access Console](https://console.nest.google.com/device-access/project-list).

To get your Device ID, refrain to https://developers.google.com/nest/device-access/reference/rest/v1/enterprises.devices/list.

To get your Google Token, refrain to https://developers.google.com/nest/device-access/authorize#get_an_access_token

## Configuration

| Option        | Default value | Description       |
|---------------|---------------|-------------------|
| width         | 33%           | Max video width   |
| nestProjectId | N/A           | Google Project ID |
| nestDeviceId  | N/A           | Google Device ID  |
| token         | N/A           | Google API ID     |

---

Based on the work done by [@shbatm](https://github.com/shbatm) for [MMM-RTSPtoWeb](https://github.com/shbatm/MMM-RTSPtoWeb)
