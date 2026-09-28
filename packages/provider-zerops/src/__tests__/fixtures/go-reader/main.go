package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	yaml2 "gopkg.in/yaml.v2"
	yaml3 "gopkg.in/yaml.v3"
)

type witness struct {
	Name     string          `json:"name"`
	Contents string          `json:"contents"`
	Expected json.RawMessage `json:"expected"`
}

// go-yaml v2 uses interface-keyed maps even when every decoded key is a string.
func jsonValue(value reflect.Value) interface{} {
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Interface, reflect.Ptr:
		if value.IsNil() {
			return nil
		}
		return jsonValue(value.Elem())
	case reflect.Map:
		result := make(map[string]interface{})
		for _, key := range value.MapKeys() {
			decoded := key
			if decoded.Kind() == reflect.Interface {
				decoded = decoded.Elem()
			}
			if decoded.Kind() != reflect.String {
				panic("reader produced a non-string key")
			}
			result[decoded.String()] = jsonValue(value.MapIndex(key))
		}
		return result
	case reflect.Slice:
		result := make([]interface{}, value.Len())
		for index := range result {
			result[index] = jsonValue(value.Index(index))
		}
		return result
	default:
		return value.Interface()
	}
}

func main() {
	var fixtures []witness
	if err := json.NewDecoder(os.Stdin).Decode(&fixtures); err != nil {
		panic(err)
	}
	readers := []struct {
		name   string
		decode func([]byte, interface{}) error
	}{
		{"go-yaml v2.4.0", yaml2.Unmarshal},
		{"go-yaml v3.0.1", yaml3.Unmarshal},
	}
	var duplicate map[string]string
	if err := yaml2.Unmarshal([]byte("x: first\nx: last\n"), &duplicate); err != nil || duplicate["x"] != "last" {
		panic("go-yaml v2 duplicate-key witness changed")
	}
	if err := yaml3.Unmarshal([]byte("x: first\nx: last\n"), &duplicate); err == nil {
		panic("go-yaml v3 duplicate-key witness changed")
	}
	for _, fixture := range fixtures {
		var expected interface{}
		if err := json.Unmarshal(fixture.Expected, &expected); err != nil {
			panic(err)
		}
		for _, reader := range readers {
			var document interface{}
			if err := reader.decode([]byte(fixture.Contents), &document); err != nil {
				panic(fmt.Sprintf("%s: %s: %v", reader.name, fixture.Name, err))
			}
			encoded, err := json.Marshal(jsonValue(reflect.ValueOf(document)))
			if err != nil {
				panic(err)
			}
			var actual interface{}
			if err := json.Unmarshal(encoded, &actual); err != nil {
				panic(err)
			}
			if !reflect.DeepEqual(expected, actual) {
				panic(fmt.Sprintf("%s: %s: decoded document differs", reader.name, fixture.Name))
			}
		}
	}
	fmt.Printf("%d witnesses passed with go-yaml v2.4.0 and v3.0.1\n", len(fixtures))
}
