PR File Diffs
/templates/apps.yml
Change Type: 2
Diff Region (removed) - Lines 1-218 → 1-0
Before:
   1: parameters:
   2: - name: AwsCredentials
   3:   type: string
   4: - name: EwbAwsCredentials
   5:   type: string
   6: - name: Namespace
   7:   type: string
   8: - name: EnvironmentK8s
   9:   type: string
  10: - name: VariableGroupAzureCr
  11:   type: string
  12: - name: Environment
  13:   type: string
  14: - name: HostedZoneId
  15:   type: string
  16: - name: ClusterHost
  17:   type: string
  18: - name: FoundationChartVersion
  19:   type: string
  20: - name: ServiceEntriesChartVersion
  21:   type: string
  22: - name: RabbitMqChartVersion
  23:   type: string
  24: - name: SetupExternalServices
  25:   type: string
  26: - name: SetupCloudServices
  27:   type: string
  28: - name: SetupErcProxy
  29:   type: string
  30: - name: SetupServiceAccounts
  31:   type: string
  32: - name: IstioRevision
  33:   type: string
  34: - name: DeploymentName
  35:   type: string
  36: - name: EwbHostName
  37:   type: string
  38: - name: EwbHostedZone
  39:   type: string
  40: - name: EwbPublicHostName
  41:   type: string
  42: - name: EwbPublicHostedZone
  43:   type: string
  44: 
  45: jobs:
  46: - deployment: ${{ parameters.DeploymentName }}
  47:   displayName: 'Deploy apps'
  48:   timeoutInMinutes: 10
  49:   workspace: 
  50:     clean: all # what to clean up before the job runs    
  51:   pool:
  52:     name: Azure EWB Linux
  53:   environment: '${{ parameters.EnvironmentK8s }}'
  54:   variables:
  55:   - group: ${{ parameters.VariableGroupAzureCr }}
  56:   strategy:
  57:     runOnce:
  58:       deploy:
  59:         steps:
  60:         - checkout: self
  61:         - task: Kubernetes@1
  62:           displayName: kubectl apply ns apps
  63:           inputs:
  64:             connectionType: 'Kubernetes Service Connection'
  65:             command: 'apply'
  66:             useConfigurationFile: true
  67:             configurationType: 'inline'
  68:             inline: |
  69:               apiVersion: v1
  70:               kind: Namespace
  71:               metadata:
  72:                 name: ${{ parameters.Namespace }}
  73:                 labels:
  74:                   istio.io/rev: ${{ parameters.IstioRevision }}
  75: 
  76:         - task: HelmInstaller@0
  77:           displayName: 'Install Helm 3.5.1'
  78:           inputs:
  79:             helmVersion: 3.5.1
  80: 
  81:         - task: HelmDeploy@0
  82:           displayName: Helm repo add
  83:           inputs:
  84:             connectionType: 'Kubernetes Service Connection'
  85:             namespace: ${{ parameters.Namespace }}
  86:             command: repo
  87:             arguments: "add ihsmarkitcommonacr https://ihsmarkitcommonacr.azurecr.io/helm/v1/repo --username $(acrUser) --password $(acrPass) --force-update"
  88:         
  89:         - task: HelmDeploy@0
  90:           displayName: 'helm repo update'
  91:           inputs:
  92:             connectionType: 'Kubernetes Service Connection'
  93:             namespace: ${{ parameters.Namespace }}
  94:             command: repo
  95:             arguments: update
  96:         
  97:         - task: HelmDeploy@0
  98:           displayName: 'helm upgrade foundation chart'
  99:           inputs:
 100:             connectionType: 'Kubernetes Service Connection'
 101:             namespace: ${{ parameters.Namespace }}
 102:             command: upgrade
 103:             chartName: 'ihsmarkitcommonacr/foundation'
 104:             chartVersion: ${{ parameters.FoundationChartVersion }}
 105:             releaseName: '${{ parameters.Namespace }}-ewb-foundation'
 106:             valueFile: './$(AwsRegion)/${{ parameters.Environment }}/foundation-values.yaml'
 107:             arguments: --timeout 5m0s --history-max 3
 108:         
 109:         - task: Kubernetes@1
 110:           name: LOAD_BALANCER_DNS_ALB
 111:           displayName: 'kubectl alb dns'
 112:           inputs:
 113:             namespace: routing
 114:             command: get
 115:             arguments: ingress -n routing ewb-alb-ingress -o jsonpath="{.metadata.annotations.alb\.ingress\.kubernetes\.io\/load-balancer-name}{' '}{.status.loadBalancer.ingress[?(@.hostname!='')].hostname}"
 116:             outputFormat: none
 117: 
 118:         # we should support legacy IHS DNS
 119:         - task: AWSShellScript@1
 120:           displayName: 'Route53 Record set upsert'
 121:           inputs:
 122:             awsCredentials: ${{ parameters.AwsCredentials }}
 123:             regionName: $(AwsRegion)
 124:             scriptType: inline
 125:             arguments: $(HostedZoneId) $(Namespace) $(ClusterHost)
 126:             inlineScript: |
 127:               loadBalancerName=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT% *})
 128:               loadBalancerDns=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT#* })
 129:               loadBalancerHostedZone=$(aws elbv2 describe-load-balancers --names=$loadBalancerName --query 'LoadBalancers[0].CanonicalHostedZoneId')
 130:               dnsName="$2-$3"
 131:               aws route53 change-resource-record-sets --hosted-zone-id $1 --change-batch '{ "Comment": "UPSERT", "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": { "Name": "'$dnsName'", "Type": "A", "AliasTarget":  { "DNSName": "'$loadBalancerDns'", "HostedZoneId": '$loadBalancerHostedZone', "EvaluateTargetHealth": true} } } ] }'
 132: 
 133:         # creating CNAME record for ALB
 134:         - task: AWSShellScript@1
 135:           displayName: 'Route53 CName Record set upsert'
 136:           inputs:
 137:             awsCredentials: ${{ parameters.EwbAwsCredentials }}
 138:             regionName: $(AwsRegion)
 139:             scriptType: inline
 140:             arguments: ${{ parameters.EwbHostedZone }} ${{ parameters.EwbHostName }}
 141:             inlineScript: |
 142:               loadBalancerName=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT% *})
 143:               loadBalancerDns=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT#* })
 144:               loadBalancerHostedZone=$(aws elbv2 describe-load-balancers --names=$loadBalancerName --query 'LoadBalancers[0].CanonicalHostedZoneId')
 145:               dnsName="$2"
 146:               aws route53 change-resource-record-sets --hosted-zone-id $1 --change-batch '{ "Comment": "UPSERT", "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": { "Name": "'$dnsName'", "Type": "CNAME", "ResourceRecords": [ { "Value": "'$loadBalancerDns'" } ], "TTL": 300 } } ] }'
 147:         
 148:         # creating public CNAME record for ALB
 149:         - task: AWSShellScript@1
 150:           displayName: 'Route53 Public CName Record set upsert'
 151:           inputs:
 152:             awsCredentials: ${{ parameters.EwbAwsCredentials }}
 153:             regionName: $(AwsRegion)
 154:             scriptType: inline
 155:             arguments: ${{ parameters.EwbPublicHostedZone }} ${{ parameters.EwbPublicHostName }}
 156:             inlineScript: |
 157:               loadBalancerName=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT% *})
 158:               loadBalancerDns=(${LOAD_BALANCER_DNS_ALB_KUBECTLOUTPUT#* })
 159:               loadBalancerHostedZone=$(aws elbv2 describe-load-balancers --names=$loadBalancerName --query 'LoadBalancers[0].CanonicalHostedZoneId')
 160:               dnsName="$2"
 161:               aws route53 change-resource-record-sets --hosted-zone-id $1 --change-batch '{ "Comment": "UPSERT", "Changes": [ { "Action": "UPSERT", "ResourceRecordSet": { "Name": "'$dnsName'", "Type": "CNAME", "ResourceRecords": [ { "Value": "'$loadBalancerDns'" } ], "TTL": 300 } } ] }'
 162:           condition: eq(variables.Environment, 'preprod')
 163:         
 164:         - task: HelmDeploy@0
 165:           displayName: 'helm upgrade service-entries chart'
 166:           inputs:
 167:             connectionType: 'Kubernetes Service Connection'
 168:             namespace: ${{ parameters.Namespace }}
 169:             command: upgrade
 170:             chartName: 'ihsmarkitcommonacr/service-entries'
 171:             chartVersion: ${{ parameters.ServiceEntriesChartVersion }}
 172:             releaseName: '${{ parameters.Namespace }}-service-entries'
 173:             valueFile: './$(AwsRegion)/${{ parameters.Environment }}/service-entries-values.yaml'
 174:             arguments: --timeout 5m0s --history-max 3
 175: 
 176:         - task: HelmDeploy@0
 177:           displayName: 'helm upgrade rabbitmq chart'
 178:           inputs:
 179:             connectionType: 'Kubernetes Service Connection'
 180:             namespace: ${{ parameters.Namespace }}
 181:             command: upgrade
 182:             chartName: 'ihsmarkitcommonacr/rabbitmq'
 183:             chartVersion: ${{ parameters.RabbitMqChartVersion }}
 184:             releaseName: 'rabbitmq'
 185:             valueFile: './$(AwsRegion)/${{ parameters.Environment }}/rabbitmq-values.yaml'
 186:             arguments: --timeout 5m0s --history-max 3
 187:             
 188:         - task: Kubernetes@1
 189:           displayName: 'Setup external service for onprem monolith'
 190:           condition: eq('${{ parameters.SetupExternalServices }}', 'true')
 191:           inputs:
 192:             namespace: ${{ parameters.Namespace }}
 193:             command: apply
 194:             arguments: -f ./$(AwsRegion)/${{ parameters.Environment }}/onprem-monolith.yaml
 195: 
 196:         - task: Kubernetes@1
 197:           displayName: 'Setup external service for cloud'
 198:           condition: eq('${{ parameters.SetupCloudServices }}', 'true')
 199:           inputs:
 200:             namespace: ${{ parameters.Namespace }}
 201:             command: apply
 202:             arguments: -f ./$(AwsRegion)/${{ parameters.Environment }}/onprem-cloud.yaml
 203: 
 204:         - task: Kubernetes@1
 205:           displayName: 'Setup external service for ERC proxy'
 206:           condition: eq('${{ parameters.SetupErcProxy }}', 'true')
 207:           inputs:
 208:             namespace: ${{ parameters.Namespace }}
 209:             command: apply
 210:             arguments: -f ./$(AwsRegion)/${{ parameters.Environment }}/onprem-erc.yaml
 211: 
 212:         - task: Kubernetes@1
 213:           displayName: 'Setup custom service accounts'
 214:           condition: eq('${{ parameters.SetupServiceAccounts }}', 'true')
 215:           inputs:
 216:             namespace: ${{ parameters.Namespace }}
 217:             command: apply
 218:             arguments: -f ./$(AwsRegion)/${{ parameters.Environment }}/service-accounts.yaml
 219: 

After:
1: